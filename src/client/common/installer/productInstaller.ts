// tslint:disable:max-classes-per-file max-classes-per-file

import { inject, injectable, named } from 'inversify';
import * as os from 'os';
import { OutputChannel, Uri } from 'vscode';
import '../../common/extensions';
import * as localize from '../../common/utils/localize';
import { IServiceContainer } from '../../ioc/types';
import { LinterId } from '../../linters/types';
import { sendTelemetryEvent } from '../../telemetry';
import { EventName } from '../../telemetry/constants';
import { IApplicationShell, ICommandManager, IWorkspaceService } from '../application/types';
import { Commands, STANDARD_OUTPUT_CHANNEL } from '../constants';
import { IPlatformService } from '../platform/types';
import { IProcessServiceFactory, IPythonExecutionFactory } from '../process/types';
import { ITerminalServiceFactory } from '../terminal/types';
import {
    IConfigurationService, IInstaller, ILogger, InstallerResponse, IOutputChannel,
    IPersistentStateFactory, ModuleNamePurpose, Product, ProductType
} from '../types';
import { ProductNames } from './productNames';
import { IInstallationChannelManager, IProductPathService, IProductService } from './types';

export { Product } from '../types';

const CTagsInsllationScript = os.platform() === 'darwin' ? 'brew install ctags' : 'sudo apt-get install exuberant-ctags';

export abstract class BaseInstaller {
    private static readonly PromptPromises = new Map<string, Promise<InstallerResponse>>();
    protected readonly appShell: IApplicationShell;
    protected readonly configService: IConfigurationService;
    private readonly workspaceService: IWorkspaceService;
    private readonly productService: IProductService;

    constructor(protected serviceContainer: IServiceContainer, protected outputChannel: OutputChannel) {
        this.appShell = serviceContainer.get<IApplicationShell>(IApplicationShell);
        this.configService = serviceContainer.get<IConfigurationService>(IConfigurationService);
        this.workspaceService = serviceContainer.get<IWorkspaceService>(IWorkspaceService);
        this.productService = serviceContainer.get<IProductService>(IProductService);
    }

    public promptToInstall(product: Product, resource?: Uri): Promise<InstallerResponse> {
        // If this method gets called twice, while previous promise has not been resolved, then return that same promise.
        // E.g. previous promise is not resolved as a message has been displayed to the user, so no point displaying
        // another message.
        const workspaceFolder = resource ? this.workspaceService.getWorkspaceFolder(resource) : undefined;
        const key = `${product}${workspaceFolder ? workspaceFolder.uri.fsPath : ''}`;
        if (BaseInstaller.PromptPromises.has(key)) {
            return BaseInstaller.PromptPromises.get(key)!;
        }
        const promise = this.promptToInstallImplementation(product, resource);
        BaseInstaller.PromptPromises.set(key, promise);
        promise.then(() => BaseInstaller.PromptPromises.delete(key)).ignoreErrors();
        promise.catch(() => BaseInstaller.PromptPromises.delete(key)).ignoreErrors();

        return promise;
    }

    public async install(product: Product, resource?: Uri): Promise<InstallerResponse> {
        if (product === Product.unittest) {
            return InstallerResponse.Installed;
        }

        const channels = this.serviceContainer.get<IInstallationChannelManager>(IInstallationChannelManager);
        const installer = await channels.getInstallationChannel(product, resource);
        if (!installer) {
            return InstallerResponse.Ignore;
        }

        const moduleName = translateProductToModule(product, ModuleNamePurpose.install);
        const logger = this.serviceContainer.get<ILogger>(ILogger);
        await installer.installModule(moduleName, resource)
            .catch(logger.logError.bind(logger, `Error in installing the module '${moduleName}'`));

        return this.isInstalled(product, resource)
            .then(isInstalled => isInstalled ? InstallerResponse.Installed : InstallerResponse.Ignore);
    }

    public async isInstalled(product: Product, resource?: Uri): Promise<boolean | undefined> {
        if (product === Product.unittest || product === Product.jupyter) {
            return true;
        }
        // User may have customized the module name or provided the fully qualified path.
        const executableName = this.getExecutableNameFromSettings(product, resource);

        const isModule = this.isExecutableAModule(product, resource);
        if (isModule) {
            const pythonProcess = await this.serviceContainer.get<IPythonExecutionFactory>(IPythonExecutionFactory).create({ resource });
            return pythonProcess.isModuleInstalled(executableName);
        } else {
            const process = await this.serviceContainer.get<IProcessServiceFactory>(IProcessServiceFactory).create(resource);
            return process.exec(executableName, ['--version'], { mergeStdOutErr: true })
                .then(() => true)
                .catch(() => false);
        }
    }

    protected abstract promptToInstallImplementation(product: Product, resource?: Uri): Promise<InstallerResponse>;
    protected getExecutableNameFromSettings(product: Product, resource?: Uri): string {
        const productType = this.productService.getProductType(product);
        const productPathService = this.serviceContainer.get<IProductPathService>(IProductPathService, productType);
        return productPathService.getExecutableNameFromSettings(product, resource);
    }
    protected isExecutableAModule(product: Product, resource?: Uri): Boolean {
        const productType = this.productService.getProductType(product);
        const productPathService = this.serviceContainer.get<IProductPathService>(IProductPathService, productType);
        return productPathService.isExecutableAModule(product, resource);
    }
}

export class CTagsInstaller extends BaseInstaller {
    constructor(serviceContainer: IServiceContainer, outputChannel: OutputChannel) {
        super(serviceContainer, outputChannel);
    }

    public async install(_product: Product, resource?: Uri): Promise<InstallerResponse> {
        if (this.serviceContainer.get<IPlatformService>(IPlatformService).isWindows) {
            this.outputChannel.appendLine('Install Universal Ctags Win32 to enable support for Workspace Symbols');
            this.outputChannel.appendLine('Download the CTags binary from the Universal CTags site.');
            this.outputChannel.appendLine('Option 1: Extract ctags.exe from the downloaded zip to any folder within your PATH so that Visual Studio Code can run it.');
            this.outputChannel.appendLine('Option 2: Extract to any folder and add the path to this folder to the command setting.');
            this.outputChannel.appendLine('Option 3: Extract to any folder and define that path in the python.workspaceSymbols.ctagsPath setting of your user settings file (settings.json).');
            this.outputChannel.show();
        } else {
            const terminalService = this.serviceContainer.get<ITerminalServiceFactory>(ITerminalServiceFactory).getTerminalService(resource);
            const logger = this.serviceContainer.get<ILogger>(ILogger);
            terminalService.sendCommand(CTagsInsllationScript, [])
                .catch(logger.logError.bind(logger, `Failed to install ctags. Script sent '${CTagsInsllationScript}'.`));
        }
        return InstallerResponse.Ignore;
    }
    protected async promptToInstallImplementation(product: Product, resource?: Uri): Promise<InstallerResponse> {
        const item = await this.appShell.showErrorMessage('Install CTags to enable Python workspace symbols?', 'Yes', 'No');
        return item === 'Yes' ? this.install(product, resource) : InstallerResponse.Ignore;
    }
}

export class FormatterInstaller extends BaseInstaller {
    protected async promptToInstallImplementation(product: Product, resource?: Uri): Promise<InstallerResponse> {
        // Hard-coded on purpose because the UI won't necessarily work having
        // another formatter.
        const formatters = [Product.autopep8, Product.black, Product.yapf];
        const formatterNames = formatters.map((formatter) => ProductNames.get(formatter)!);
        const productName = ProductNames.get(product)!;
        formatterNames.splice(formatterNames.indexOf(productName), 1);
        const useOptions = formatterNames.map((name) => `Use ${name}`);
        const yesChoice = 'Yes';

        const options = [...useOptions];
        let message = `Formatter ${productName} is not installed. Install?`;
        if (this.isExecutableAModule(product, resource)) {
            options.splice(0, 0, yesChoice);
        } else {
            const executable = this.getExecutableNameFromSettings(product, resource);
            message = `Path to the ${productName} formatter is invalid (${executable})`;
        }

        const item = await this.appShell.showErrorMessage(message, ...options);
        if (item === yesChoice) {
            return this.install(product, resource);
        } else if (typeof item === 'string') {
            for (const formatter of formatters) {
                const formatterName = ProductNames.get(formatter)!;

                if (item.endsWith(formatterName)) {
                    await this.configService.updateSetting('formatting.provider', formatterName, resource);
                    return this.install(formatter, resource);
                }
            }
        }

        return InstallerResponse.Ignore;
    }
}

export class LinterInstaller extends BaseInstaller {
    protected async promptToInstallImplementation(product: Product, resource?: Uri): Promise<InstallerResponse> {
        const isPylint = product === Product.pylint;

        const productName = ProductNames.get(product)!;
        const install = 'Install';
        const disableInstallPrompt = 'Do not show again';
        const disableLinterInstallPromptKey = `${productName}_DisableLinterInstallPrompt`;
        const selectLinter = 'Select Linter';

        if (isPylint && this.getStoredResponse(disableLinterInstallPromptKey) === true) {
            return InstallerResponse.Ignore;
        }

        const options = isPylint ? [disableInstallPrompt] : [selectLinter];

        let message = `Linter ${productName} is not installed.`;
        if (this.isExecutableAModule(product, resource)) {
            options.splice(0, 0, install);
        } else {
            const executable = this.getExecutableNameFromSettings(product, resource);
            message = `Path to the ${productName} linter is invalid (${executable})`;
        }
        const response = await this.appShell.showErrorMessage(message, ...options);
        if (response === install) {
            sendTelemetryEvent(EventName.LINTER_NOT_INSTALLED_PROMPT, undefined, { tool: productName as LinterId, action: 'install' });
            return this.install(product, resource);
        } else if (response === disableInstallPrompt) {
            await this.setStoredResponse(disableLinterInstallPromptKey, true);
            sendTelemetryEvent(EventName.LINTER_NOT_INSTALLED_PROMPT, undefined, { tool: productName as LinterId, action: 'disablePrompt' });
            return InstallerResponse.Ignore;
        }

        if (response === selectLinter) {
            sendTelemetryEvent(EventName.LINTER_NOT_INSTALLED_PROMPT, undefined, { action: 'select' });
            const commandManager = this.serviceContainer.get<ICommandManager>(ICommandManager);
            await commandManager.executeCommand(Commands.Set_Linter);
        }
        return InstallerResponse.Ignore;
    }

    /**
     * For installers that want to avoid prompting the user over and over, they can make use of a
     * persisted true/false value representing user responses to 'stop showing this prompt'. This method
     * gets the persisted value given the installer-defined key.
     *
     * @param key Key to use to get a persisted response value, each installer must define this for themselves.
     * @returns Boolean: The current state of the stored response key given.
     */
    protected getStoredResponse(key: string): boolean {
        const factory = this.serviceContainer.get<IPersistentStateFactory>(IPersistentStateFactory);
        const state = factory.createGlobalPersistentState<boolean | undefined>(key, undefined);
        return state.value === true;
    }

    /**
     * For installers that want to avoid prompting the user over and over, they can make use of a
     * persisted true/false value representing user responses to 'stop showing this prompt'. This
     * method will set that persisted value given the installer-defined key.
     *
     * @param key Key to use to get a persisted response value, each installer must define this for themselves.
     * @param value Boolean value to store for the user - if they choose to not be prompted again for instance.
     * @returns Boolean: The current state of the stored response key given.
     */
    private async setStoredResponse(key: string, value: boolean): Promise<void> {
        const factory = this.serviceContainer.get<IPersistentStateFactory>(IPersistentStateFactory);
        const state = factory.createGlobalPersistentState<boolean | undefined>(key, undefined);
        if (state && state.value !== value) {
            await state.updateValue(value);
        }
    }
}

export class TestFrameworkInstaller extends BaseInstaller {
    protected async promptToInstallImplementation(product: Product, resource?: Uri): Promise<InstallerResponse> {
        const productName = ProductNames.get(product)!;

        const options: string[] = [];
        let message = `Test framework ${productName} is not installed. Install?`;
        if (this.isExecutableAModule(product, resource)) {
            options.push(...['Yes', 'No']);
        } else {
            const executable = this.getExecutableNameFromSettings(product, resource);
            message = `Path to the ${productName} test framework is invalid (${executable})`;
        }

        const item = await this.appShell.showErrorMessage(message, ...options);
        return item === 'Yes' ? this.install(product, resource) : InstallerResponse.Ignore;
    }
}

export class RefactoringLibraryInstaller extends BaseInstaller {
    protected async promptToInstallImplementation(product: Product, resource?: Uri): Promise<InstallerResponse> {
        const productName = ProductNames.get(product)!;
        const item = await this.appShell.showErrorMessage(`Refactoring library ${productName} is not installed. Install?`, 'Yes', 'No');
        return item === 'Yes' ? this.install(product, resource) : InstallerResponse.Ignore;
    }
}

export class DataScienceInstaller extends BaseInstaller {
    protected async promptToInstallImplementation(product: Product, resource?: Uri): Promise<InstallerResponse> {
        const productName = ProductNames.get(product)!;
        const item = await this.appShell.showErrorMessage(localize.DataScience.libraryNotInstalled().format(productName), 'Yes', 'No');
        return item === 'Yes' ? this.install(product, resource) : InstallerResponse.Ignore;
    }
}

@injectable()
export class ProductInstaller implements IInstaller {
    private readonly productService: IProductService;

    constructor(@inject(IServiceContainer) private serviceContainer: IServiceContainer,
        @inject(IOutputChannel) @named(STANDARD_OUTPUT_CHANNEL) private outputChannel: OutputChannel) {
        this.productService = serviceContainer.get<IProductService>(IProductService);
    }

    // tslint:disable-next-line:no-empty
    public dispose() { }
    public async promptToInstall(product: Product, resource?: Uri): Promise<InstallerResponse> {
        return this.createInstaller(product).promptToInstall(product, resource);
    }
    public async install(product: Product, resource?: Uri): Promise<InstallerResponse> {
        return this.createInstaller(product).install(product, resource);
    }
    public async isInstalled(product: Product, resource?: Uri): Promise<boolean | undefined> {
        return this.createInstaller(product).isInstalled(product, resource);
    }
    public translateProductToModuleName(product: Product, purpose: ModuleNamePurpose): string {
        return translateProductToModule(product, purpose);
    }
    private createInstaller(product: Product): BaseInstaller {
        const productType = this.productService.getProductType(product);
        switch (productType) {
            case ProductType.Formatter:
                return new FormatterInstaller(this.serviceContainer, this.outputChannel);
            case ProductType.Linter:
                return new LinterInstaller(this.serviceContainer, this.outputChannel);
            case ProductType.WorkspaceSymbols:
                return new CTagsInstaller(this.serviceContainer, this.outputChannel);
            case ProductType.TestFramework:
                return new TestFrameworkInstaller(this.serviceContainer, this.outputChannel);
            case ProductType.RefactoringLibrary:
                return new RefactoringLibraryInstaller(this.serviceContainer, this.outputChannel);
            case ProductType.DataScience:
                return new DataScienceInstaller(this.serviceContainer, this.outputChannel);
            default:
                break;
        }
        throw new Error(`Unknown product ${product}`);
    }
}

function translateProductToModule(product: Product, purpose: ModuleNamePurpose): string {
    switch (product) {
        case Product.mypy: return 'mypy';
        case Product.nosetest: {
            return purpose === ModuleNamePurpose.install ? 'nose' : 'nosetests';
        }
        case Product.pylama: return 'pylama';
        case Product.prospector: return 'prospector';
        case Product.pylint: return 'pylint-starlark';
        case Product.pytest: return 'pytest';
        case Product.autopep8: return 'autopep8';
        case Product.black: return 'black';
        case Product.pycodestyle: return 'pycodestyle';
        case Product.pydocstyle: return 'pydocstyle';
        case Product.yapf: return 'yapf';
        case Product.flake8: return 'flake8';
        case Product.unittest: return 'unittest';
        case Product.rope: return 'rope';
        case Product.bandit: return 'bandit';
        case Product.jupyter: return 'jupyter';
        default: {
            throw new Error(`Product ${product} cannot be installed as a Python Module.`);
        }
    }
}
