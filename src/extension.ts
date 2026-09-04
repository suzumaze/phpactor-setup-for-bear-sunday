import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    SetupState,
    SettingSnapshot,
    StoredFileSnapshot,
    PHPACTOR_VERSION,
    atomicWriteTextFile,
    beginSetupState,
    configSeedContent,
    fileSnapshotsEqual,
    globalComposerJson,
    globalConfigFile,
    globalConfigRestoreDisposition,
    isSupportedPhpVersion,
    parsePhpVersionProbe,
    parseSetupState,
    phpactorPathRestoreDisposition,
    readFileSnapshot,
    readJsonConfigSnapshot,
    recordManagedGlobalConfig,
    recordManagedPhpactorPath,
    removeManagedInstallDirectory,
    restoreGlobalConfig,
    settingSnapshotsEqual,
    validateGeneratedConfig,
} from './setup-core';

const BEAR_RESOURCE_PACKAGE = 'bear/resource';
const GLOBAL_DIR_NAME = 'phpactor-global';
const INIT_BIN = 'bear-phpactor-init';
const PHPACTOR_BIN_REL = path.join('vendor', 'bin', 'phpactor');
const GENERATED_CONFIG = '.phpactor.json';
const RESTORE_STATE_KEY = 'phpactorSetup.restoreState';
const SETUP_DONE_PREFIX = 'phpactorSetup.setupDone:';

// Prevent setup and restore, or auto-detection and an explicit command, from
// mutating the same global resources concurrently.
let operationRunning = false;

function setupDoneKey(projectPath: string): string {
    return `${SETUP_DONE_PREFIX}${projectPath}`;
}

function skipPromptKey(projectPath: string): string {
    return `phpactorSetup.skipPrompt:${projectPath}`;
}

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('phpactorSetup.setup', () => runSetup(context)),
        vscode.commands.registerCommand('phpactorSetup.restore', () => runRestore(context)),
    );
    void promptForSetupIfNeeded(context);
}

export function deactivate(): void {
    // No resources to release.
}

interface BearProject {
    folder: vscode.WorkspaceFolder;
}

function findBearProject(): BearProject | undefined {
    const folders = vscode.workspace.workspaceFolders;
    if (folders === undefined || folders.length === 0) {
        return undefined;
    }
    for (const folder of folders) {
        const composerPath = path.join(folder.uri.fsPath, 'composer.json');
        let composer: unknown;
        try {
            composer = JSON.parse(fs.readFileSync(composerPath, 'utf8'));
        } catch {
            continue;
        }
        if (composer !== null && typeof composer === 'object') {
            const record = composer as Record<string, unknown>;
            const required = {
                ...asRecord(record['require']),
                ...asRecord(record['require-dev']),
            };
            if (required[BEAR_RESOURCE_PACKAGE] !== undefined) {
                return { folder };
            }
        }
    }

    return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object'
        ? (value as Record<string, unknown>)
        : {};
}

/**
 * GUI-launched VS Code can have a minimal PATH, so also check the standard
 * Homebrew locations without invoking a shell.
 */
function findExecutable(bin: string): string | undefined {
    const pathDirs = (process.env.PATH ?? '')
        .split(path.delimiter)
        .filter((dir) => dir !== '');
    const candidates = [...new Set([...pathDirs, '/opt/homebrew/bin', '/usr/local/bin'])];
    for (const dir of candidates) {
        const candidate = path.join(dir, bin);
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return candidate;
        } catch {
            // Try the next candidate.
        }
    }

    return undefined;
}

function execFileAsync(
    cmd: string,
    args: string[],
    options: cp.ExecFileOptions = {},
): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        cp.execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
            if (error !== null) {
                const detail = String(stderr).trim();
                reject(new Error(detail !== '' ? `${error.message}\n${detail}` : error.message));
                return;
            }
            resolve({ stdout: String(stdout), stderr: String(stderr) });
        });
    });
}

function resolveInitBin(globalDir: string): string | undefined {
    const packageBin = path.join(
        globalDir,
        'vendor',
        'suzumaze',
        'bear-phpactor-extension',
        'bin',
        INIT_BIN,
    );
    if (fs.existsSync(packageBin)) {
        // v0.1.0 resolves ../vendor/autoload.php relative to its own __DIR__.
        // Composer's generated proxy includes it from vendor/suzumaze/... and
        // therefore cannot satisfy that lookup. Stage the unchanged upstream
        // initializer under <globalDir>/bin so ../vendor/autoload.php is the
        // shared autoloader. The config merge still belongs entirely to
        // bear-phpactor-init rather than being duplicated here.
        const stagedBin = path.join(globalDir, 'bin', INIT_BIN);
        atomicWriteTextFile(stagedBin, fs.readFileSync(packageBin, 'utf8'));
        return stagedBin;
    }

    const composerProxy = path.join(globalDir, 'vendor', 'bin', INIT_BIN);
    if (fs.existsSync(composerProxy)) {
        return composerProxy;
    }

    return undefined;
}

async function runInitializer(
    php: string,
    initBin: string,
    globalDir: string,
    phpactorBin: string,
): Promise<void> {
    // Phpactor reads global XDG config even when --working-dir points at the
    // clean directory created by bear-phpactor-init. Give the subprocess its
    // own XDG roots so an existing/stale extension list cannot shadow the
    // pinned Phpactor defaults, and no real user config/data/cache is touched.
    const isolatedRoot = fs.mkdtempSync(path.join(globalDir, '.init-environment-'));
    const xdgConfig = path.join(isolatedRoot, 'config');
    const xdgData = path.join(isolatedRoot, 'data');
    const xdgCache = path.join(isolatedRoot, 'cache');
    for (const directory of [xdgConfig, xdgData, xdgCache]) {
        fs.mkdirSync(directory, { recursive: true });
    }

    try {
        await execFileAsync(php, [initBin], {
            cwd: globalDir,
            env: {
                ...process.env,
                PHPACTOR_BIN: phpactorBin,
                XDG_CONFIG_HOME: xdgConfig,
                XDG_DATA_HOME: xdgData,
                XDG_CACHE_HOME: xdgCache,
            },
        });
    } finally {
        fs.rmSync(isolatedRoot, { recursive: true, force: true });
    }
}

function globalPhpactorPathSnapshot(configuration: vscode.WorkspaceConfiguration): SettingSnapshot {
    const globalValue = configuration.inspect<string | null>('path')?.globalValue;
    if (globalValue === undefined) {
        return { configured: false };
    }
    if (globalValue !== null && typeof globalValue !== 'string') {
        throw new Error('VS Code User Settings の phpactor.path が文字列または null ではありません。');
    }

    return { configured: true, value: globalValue };
}

async function readRestoreState(context: vscode.ExtensionContext): Promise<SetupState | undefined> {
    return parseSetupState(context.globalState.get<unknown>(RESTORE_STATE_KEY));
}

async function saveRestoreState(
    context: vscode.ExtensionContext,
    state: SetupState | undefined,
): Promise<void> {
    await context.globalState.update(RESTORE_STATE_KEY, state);
}

function extensionVersion(context: vscode.ExtensionContext): string {
    const version: unknown = context.extension.packageJSON['version'];
    return typeof version === 'string' ? version : 'unknown';
}

async function promptForSetupIfNeeded(context: vscode.ExtensionContext): Promise<void> {
    const project = findBearProject();
    if (project === undefined) {
        return;
    }
    const projectPath = project.folder.uri.fsPath;
    if (context.globalState.get<boolean>(setupDoneKey(projectPath)) === true
        || context.globalState.get<boolean>(skipPromptKey(projectPath)) === true
    ) {
        return;
    }

    const answer = await vscode.window.showInformationMessage(
        'BEAR.Sundayプロジェクトを検出しました。複数のBEAR.Sundayプロジェクトから共有されるグローバルPhpactorセットアップを行いますか？',
        'セットアップする',
        '今回はしない',
        '今後確認しない',
    );
    if (answer === 'セットアップする') {
        if (context.globalState.get<boolean>(setupDoneKey(projectPath)) !== true) {
            await runSetup(context);
        }
    } else if (answer === '今後確認しない') {
        await context.globalState.update(skipPromptKey(projectPath), true);
    }
}

async function runSetup(context: vscode.ExtensionContext): Promise<void> {
    if (operationRunning) {
        vscode.window.showInformationMessage('グローバルセットアップまたはrestoreはすでに実行中です。');
        return;
    }
    operationRunning = true;
    try {
        const project = findBearProject();
        if (project === undefined) {
            vscode.window.showErrorMessage(
                'composer.json の require / require-dev に bear/resource が見つからないため、グローバルセットアップを中止しました。',
            );
            return;
        }

        const composer = findExecutable('composer');
        if (composer === undefined) {
            vscode.window.showErrorMessage(
                'composer が見つかりません。https://getcomposer.org/download/ の手順でインストールし、PATH を通してください。',
            );
            return;
        }
        const php = findExecutable('php');
        if (php === undefined) {
            vscode.window.showErrorMessage('php が見つかりません。PHP 8.2 以上をインストールし、PATH を通してください。');
            return;
        }

        const probeResult = await execFileAsync(php, ['-r', 'echo PHP_VERSION_ID, "\\n", PHP_VERSION;']);
        const phpVersion = parsePhpVersionProbe(probeResult.stdout);
        if (!isSupportedPhpVersion(phpVersion.versionId)) {
            vscode.window.showErrorMessage(
                `PHP ${phpVersion.version} が検出されました。Phpactor ${PHPACTOR_VERSION} の実行にはPHP 8.2以上が必要です。`,
            );
            return;
        }

        const targetConfig = globalConfigFile(process.env, os.homedir());
        let configBeforeSetup: StoredFileSnapshot;
        try {
            configBeforeSetup = readJsonConfigSnapshot(targetConfig);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(
                `既存のPhpactor global configを安全に読み込めません。ファイルは変更していません: ${detail}`,
            );
            return;
        }

        let previousState: SetupState | undefined;
        try {
            previousState = await readRestoreState(context);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            vscode.window.showErrorMessage(`${detail} backupを上書きせず、セットアップを中止しました。`);
            return;
        }
        if (previousState !== undefined
            && previousState.managed.globalConfig !== undefined
            && path.resolve(previousState.original.globalConfigPath) !== path.resolve(targetConfig)
        ) {
            vscode.window.showErrorMessage(
                `保存済みbackupは別のPhpactor global config（${previousState.original.globalConfigPath}）に対応しています。XDG_CONFIG_HOMEを元に戻してrestoreしてから再実行してください。`,
            );
            return;
        }

        const phpactorConfiguration = vscode.workspace.getConfiguration('phpactor');
        const pathBeforeSetup = globalPhpactorPathSnapshot(phpactorConfiguration);
        const globalDir = path.join(context.globalStorageUri.fsPath, GLOBAL_DIR_NAME);
        const phpactorBin = path.join(globalDir, PHPACTOR_BIN_REL);
        const installationExists = fs.existsSync(phpactorBin);
        const composerLockExists = fs.existsSync(path.join(globalDir, 'composer.lock'));
        const composerFile = path.join(globalDir, 'composer.json');
        const desiredComposerJson = globalComposerJson();
        let installedComposerJson: string | undefined;
        try {
            installedComposerJson = fs.readFileSync(composerFile, 'utf8');
        } catch (error) {
            if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
                throw error;
            }
        }
        const compatibilityManifestChanged = installedComposerJson !== desiredComposerJson;

        if (installationExists) {
            const legacyInstallation = previousState === undefined;
            const answer = await vscode.window.showWarningMessage(
                legacyInstallation
                    ? 'backup機能導入前のグローバルセットアップを検出しました。当時のセットアップ前状態は復元できないため、現在のconfigとphpactor.pathを新しい復元基準として保存します。続行しますか？'
                    : compatibilityManifestChanged
                    ? `既存のグローバルセットアップを検証済みPhpactor ${PHPACTOR_VERSION}へ更新し、設定を再生成します。続行しますか？`
                    : `既存のグローバルセットアップを再検証し、設定を安全に再生成します。続行しますか？`,
                { modal: true },
                'キャンセル',
                '更新する',
            );
            if (answer !== '更新する') {
                return;
            }
        }

        if (!settingSnapshotsEqual(pathBeforeSetup, { configured: true, value: phpactorBin })) {
            const current = pathBeforeSetup.configured ? String(pathBeforeSetup.value) : '未設定';
            const answer = await vscode.window.showWarningMessage(
                `VS Code User Settings（global）の phpactor.path は現在「${current}」です。「${phpactorBin}」へ変更します。続行しますか？`,
                { modal: true },
                'キャンセル',
                '変更して続行',
            );
            if (answer !== '変更して続行') {
                return;
            }
        }

        let state = beginSetupState(
            previousState,
            targetConfig,
            configBeforeSetup,
            pathBeforeSetup,
            globalDir,
            extensionVersion(context),
        );
        // Persist the first-intervention backup before creating or changing
        // any managed installation/configuration resource.
        await saveRestoreState(context, state);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'グローバルPhpactorセットアップ',
                cancellable: false,
            },
            async (progress) => {
                fs.mkdirSync(globalDir, { recursive: true });
                atomicWriteTextFile(composerFile, desiredComposerJson);

                // Keep the tested resolution stable on ordinary repeated
                // setup. Resolve again only when this extension deliberately
                // changes its compatibility manifest or no lock exists.
                const composerAction = composerLockExists && compatibilityManifestChanged
                    ? 'update'
                    : 'install';

                progress.report({
                    message: !installationExists
                        ? '検証済みバージョンをインストールしています（初回は数分かかります）…'
                        : composerAction === 'update'
                        ? '検証済みバージョンへ更新しています…'
                        : 'lock済みdependencyを再検証しています…',
                });
                await execFileAsync(
                    composer,
                    [composerAction, '--no-interaction', '--no-progress'],
                    { cwd: globalDir },
                );

                const initBin = resolveInitBin(globalDir);
                if (initBin === undefined) {
                    throw new Error(`vendor/bin/${INIT_BIN} が見つかりません。Composer処理が正しく完了したか確認してください。`);
                }

                // Seed the initializer with the complete current user config.
                // bear-phpactor-init owns extension_classes regeneration and
                // de-duplication; this setup helper validates the result.
                const generated = path.join(globalDir, GENERATED_CONFIG);
                const seedContent = configSeedContent(configBeforeSetup);
                atomicWriteTextFile(generated, seedContent);
                progress.report({ message: '既存設定を保持してPhpactor extension listを再生成しています…' });
                await runInitializer(php, initBin, globalDir, phpactorBin);

                const generatedContent = fs.readFileSync(generated, 'utf8');
                validateGeneratedConfig(seedContent, generatedContent);

                // Abort on concurrent edits instead of overwriting a config or
                // User setting that changed while Composer was running.
                const latestConfig = readJsonConfigSnapshot(targetConfig);
                if (!fileSnapshotsEqual(latestConfig, configBeforeSetup)) {
                    throw new Error(`${targetConfig} がセットアップ中に変更されたため、安全のため反映を中止しました。`);
                }
                const latestPath = globalPhpactorPathSnapshot(phpactorConfiguration);
                if (!settingSnapshotsEqual(latestPath, pathBeforeSetup)) {
                    throw new Error('VS Code User Settings の phpactor.path がセットアップ中に変更されたため、反映を中止しました。');
                }

                progress.report({ message: 'Phpactor global configをatomicに反映しています…' });
                state = recordManagedGlobalConfig(state, targetConfig, configBeforeSetup, generatedContent);
                await saveRestoreState(context, state);
                atomicWriteTextFile(targetConfig, generatedContent);

                progress.report({ message: 'VS Code User Settingsを更新しています…' });
                state = recordManagedPhpactorPath(state, pathBeforeSetup, phpactorBin);
                await saveRestoreState(context, state);
                await phpactorConfiguration.update('path', phpactorBin, vscode.ConfigurationTarget.Global);

                await context.globalState.update(setupDoneKey(project.folder.uri.fsPath), true);
            },
        );

        const choice = await vscode.window.showInformationMessage(
            'グローバルPhpactorセットアップが完了しました。設定を反映するには再読み込みが必要です。',
            '再読み込み',
        );
        if (choice === '再読み込み') {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`グローバルセットアップに失敗しました: ${detail}`);
    } finally {
        operationRunning = false;
    }
}

async function runRestore(context: vscode.ExtensionContext): Promise<void> {
    if (operationRunning) {
        vscode.window.showInformationMessage('グローバルセットアップまたはrestoreはすでに実行中です。');
        return;
    }
    operationRunning = true;
    try {
        const storedState = await readRestoreState(context);
        if (storedState === undefined) {
            vscode.window.showInformationMessage('復元するグローバルセットアップのbackupはありません。');
            return;
        }
        let state: SetupState = storedState;

        const phpactorConfiguration = vscode.workspace.getConfiguration('phpactor');
        const configDisposition = state.managed.globalConfig === undefined
            ? 'already-restored'
            : globalConfigRestoreDisposition(state, readFileSnapshot(state.managed.globalConfig.path));
        const pathDisposition = phpactorPathRestoreDisposition(
            state,
            globalPhpactorPathSnapshot(phpactorConfiguration),
        );
        const conflicts: string[] = [];
        if (configDisposition === 'conflict') {
            conflicts.push('Phpactor global config');
        }
        if (pathDisposition === 'conflict') {
            conflicts.push('VS Code User Settings の phpactor.path');
        }

        let forceConfigConflict = false;
        let forcePathConflict = false;
        if (conflicts.length > 0) {
            const answer = await vscode.window.showWarningMessage(
                `セットアップ後に ${conflicts.join(' と ')} が変更されています。これらの変更を破棄して、初回セットアップ前の状態へ戻しますか？`,
                { modal: true },
                'キャンセル',
                '変更を破棄して復元',
            );
            if (answer !== '変更を破棄して復元') {
                return;
            }
            forceConfigConflict = configDisposition === 'conflict';
            forcePathConflict = pathDisposition === 'conflict';
        }

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'グローバルPhpactorセットアップを復元',
                cancellable: false,
            },
            async (progress) => {
                const managedConfig = state.managed.globalConfig;
                if (managedConfig !== undefined) {
                    const latestDisposition = globalConfigRestoreDisposition(
                        state,
                        readFileSnapshot(managedConfig.path),
                    );
                    if (latestDisposition === 'conflict' && !forceConfigConflict) {
                        throw new Error('Phpactor global config が確認後に変更されたため、復元を中止しました。');
                    }
                    if (latestDisposition !== 'already-restored') {
                        progress.report({ message: 'Phpactor global configを復元しています…' });
                        restoreGlobalConfig(managedConfig.path, state.original.globalConfig);
                    }
                    state = withoutManagedConfig(state);
                    await saveRestoreState(context, state);
                }

                if (state.managed.phpactorPath !== undefined) {
                    const latestDisposition = phpactorPathRestoreDisposition(
                        state,
                        globalPhpactorPathSnapshot(phpactorConfiguration),
                    );
                    if (latestDisposition === 'conflict' && !forcePathConflict) {
                        throw new Error('VS Code User Settings の phpactor.path が確認後に変更されたため、復元を中止しました。');
                    }
                    if (latestDisposition !== 'already-restored') {
                        progress.report({ message: 'VS Code User Settingsを復元しています…' });
                        const original = state.original.phpactorPath;
                        await phpactorConfiguration.update(
                            'path',
                            original.configured ? original.value : undefined,
                            vscode.ConfigurationTarget.Global,
                        );
                    }
                    state = withoutManagedPhpactorPath(state);
                    await saveRestoreState(context, state);
                }

                if (state.managed.installDir !== undefined) {
                    progress.report({ message: 'この拡張が管理するPhpactor installationを削除しています…' });
                    removeManagedInstallDirectory(context.globalStorageUri.fsPath, state.managed.installDir);
                    state = withoutManagedInstallDir(state);
                    await saveRestoreState(context, state);
                }
            },
        );

        for (const key of context.globalState.keys()) {
            if (key.startsWith(SETUP_DONE_PREFIX)) {
                await context.globalState.update(key, undefined);
            }
        }
        // Keep the empty restore state until ancillary setup markers are
        // cleared. If that update fails, rerunning restore can finish the
        // cleanup without touching already-restored resources.
        await saveRestoreState(context, undefined);
        vscode.window.showInformationMessage('グローバルPhpactorセットアップを初回セットアップ前の状態へ戻しました。');
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`グローバルセットアップの復元に失敗しました: ${detail}`);
    } finally {
        operationRunning = false;
    }
}

function withoutManagedConfig(state: SetupState): SetupState {
    const managed = { ...state.managed };
    delete managed.globalConfig;
    return { ...state, managed };
}

function withoutManagedPhpactorPath(state: SetupState): SetupState {
    const managed = { ...state.managed };
    delete managed.phpactorPath;
    return { ...state, managed };
}

function withoutManagedInstallDir(state: SetupState): SetupState {
    const managed = { ...state.managed };
    delete managed.installDir;
    return { ...state, managed };
}
