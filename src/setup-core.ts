import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isDeepStrictEqual } from 'util';

export const SETUP_STATE_SCHEMA_VERSION = 1;
export const BEAR_EXTENSION_CLASS = 'Suzumaze\\BearPhpactor\\BearSundayExtension';
export const EXTENSION_CLASSES_KEY = 'container.extension_classes';
export const MINIMUM_PHP_VERSION_ID = 80200;

// This exact release is exercised by bear-phpactor-extension v0.1.1 and the
// official VS Code client. Phpactor's date-shaped CalVer does not promise
// compatibility of its internal extension APIs across later dates.
export const PHPACTOR_VERSION = '2026.07.22.0';

// phpactor/language-server 7.0.1 loses didChange notifications with protocol
// 3.17.5+. Upstream PR #68 is merged, but no stable language-server release
// contains it yet. Keep 3.17.4 until such a release is verified here.
export const LANGUAGE_SERVER_PROTOCOL_VERSION = '3.17.4';
export const BEAR_PHPACTOR_EXTENSION_VERSION = '^0.1.1';

export type FileSnapshot =
    | { kind: 'missing' }
    | { kind: 'file'; content: string }
    | { kind: 'other' };

export type StoredFileSnapshot = Exclude<FileSnapshot, { kind: 'other' }>;

export type SettingSnapshot =
    | { configured: false }
    | { configured: true; value: string | null };

export interface ManagedGlobalConfig {
    path: string;
    content: string;
    sha256: string;
    userChangesSeen: boolean;
}

export interface ManagedPhpactorPath {
    value: string;
    userChangesSeen: boolean;
}

export interface SetupState {
    schemaVersion: typeof SETUP_STATE_SCHEMA_VERSION;
    setupVersion: string;
    original: {
        globalConfigPath: string;
        globalConfig: StoredFileSnapshot;
        phpactorPath: SettingSnapshot;
    };
    managed: {
        installDir?: string;
        globalConfig?: ManagedGlobalConfig;
        phpactorPath?: ManagedPhpactorPath;
    };
}

export type RestoreDisposition = 'restore' | 'already-restored' | 'conflict';
export type RestoreWriteDisposition = RestoreDisposition | 'changed-after-confirmation';

export interface PhpVersionProbe {
    versionId: number;
    version: string;
}

export function globalConfigFile(
    environment: NodeJS.ProcessEnv,
    homeDirectory: string,
): string {
    const xdg = environment.XDG_CONFIG_HOME;
    if (xdg !== undefined && xdg !== '' && !path.isAbsolute(xdg)) {
        throw new Error('XDG_CONFIG_HOME must be an absolute path');
    }
    const base = xdg !== undefined && xdg !== ''
        ? xdg
        : path.join(homeDirectory, '.config');

    return path.join(base, 'phpactor', 'phpactor.json');
}

/**
 * Phpactor itself needs dev stability for two development-branch packages.
 * prefer-stable still keeps every other dependency stable where possible.
 */
export function globalComposerJson(): string {
    const composer = {
        'minimum-stability': 'dev',
        'prefer-stable': true,
        require: {
            php: '^8.2',
            'phpactor/phpactor': PHPACTOR_VERSION,
            'phpactor/language-server-protocol': LANGUAGE_SERVER_PROTOCOL_VERSION,
            'suzumaze/bear-phpactor-extension': BEAR_PHPACTOR_EXTENSION_VERSION,
        },
    };

    return JSON.stringify(composer, null, 4) + '\n';
}

export function readFileSnapshot(file: string): FileSnapshot {
    let stat: fs.Stats;
    try {
        stat = fs.lstatSync(file);
    } catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
            return { kind: 'missing' };
        }
        throw error;
    }

    if (!stat.isFile()) {
        return { kind: 'other' };
    }

    return { kind: 'file', content: fs.readFileSync(file, 'utf8') };
}

/**
 * Read and validate the user's global config before doing any setup work.
 * Symlinks and non-files are rejected because an atomic rename would replace
 * the directory entry rather than safely updating the intended file.
 */
export function readJsonConfigSnapshot(file: string): StoredFileSnapshot {
    const snapshot = readFileSnapshot(file);
    if (snapshot.kind === 'other') {
        throw new Error(`${file} is not a regular file`);
    }
    if (snapshot.kind === 'file') {
        parseJsonObject(snapshot.content, file);
    }

    return snapshot;
}

export function configSeedContent(snapshot: StoredFileSnapshot): string {
    return snapshot.kind === 'file' ? snapshot.content : '{}\n';
}

/**
 * `bear-phpactor-init` owns extension-class generation. This validation keeps
 * the setup helper from publishing a malformed result or silently dropping a
 * key or extension class from the user's seed config. Missing classes are not
 * merged here because the managed Composer autoloader may not provide them.
 */
export function validateGeneratedConfig(seedContent: string, generatedContent: string): void {
    const seed = parseJsonObject(seedContent, 'Phpactor config seed');
    const generated = parseJsonObject(generatedContent, 'generated Phpactor config');

    for (const [key, value] of Object.entries(seed)) {
        if (key === EXTENSION_CLASSES_KEY) {
            continue;
        }
        if (!Object.prototype.hasOwnProperty.call(generated, key) || !isDeepStrictEqual(generated[key], value)) {
            throw new Error(`bear-phpactor-init did not preserve existing setting "${key}"`);
        }
    }

    const classes = generated[EXTENSION_CLASSES_KEY];
    if (!Array.isArray(classes) || !classes.every((item) => typeof item === 'string')) {
        throw new Error(`generated Phpactor config has no valid "${EXTENSION_CLASSES_KEY}" list`);
    }
    if (classes.filter((item) => item === BEAR_EXTENSION_CLASS).length !== 1) {
        throw new Error('generated Phpactor config must contain the BEAR.Sunday extension exactly once');
    }
    if (classes[0] !== BEAR_EXTENSION_CLASS) {
        throw new Error('generated Phpactor config must place the BEAR.Sunday extension first');
    }
    if (new Set(classes).size !== classes.length) {
        throw new Error('generated Phpactor config contains duplicate extension classes');
    }

    const seedClasses = seed[EXTENSION_CLASSES_KEY];
    if (seedClasses !== undefined) {
        if (!Array.isArray(seedClasses) || !seedClasses.every((item) => typeof item === 'string')) {
            throw new Error(`existing Phpactor config has no valid "${EXTENSION_CLASSES_KEY}" list`);
        }
        for (const existingClass of new Set(seedClasses)) {
            if (!classes.includes(existingClass)) {
                throw new Error(
                    `bear-phpactor-init did not preserve existing extension class "${existingClass}"; `
                    + 'setup was stopped because this class may require a different Composer autoloader',
                );
            }
        }
    }
}

/** Write in the destination directory, flush, and rename into place. */
export function atomicWriteTextFile(file: string, content: string): void {
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true });

    let mode = 0o600;
    try {
        const stat = fs.statSync(file);
        if (stat.isFile()) {
            mode = stat.mode & 0o777;
        }
    } catch (error) {
        if (!isNodeError(error) || error.code !== 'ENOENT') {
            throw error;
        }
    }

    const temporary = path.join(
        directory,
        `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
    );
    let descriptor: number | undefined;
    try {
        descriptor = fs.openSync(temporary, 'wx', mode);
        fs.writeFileSync(descriptor, content, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporary, file);
        flushDirectory(directory);
    } catch (error) {
        if (descriptor !== undefined) {
            fs.closeSync(descriptor);
        }
        try {
            fs.unlinkSync(temporary);
        } catch (cleanupError) {
            if (!isNodeError(cleanupError) || cleanupError.code !== 'ENOENT') {
                // Preserve the original write error; the uniquely named temp
                // file can be inspected or removed later.
            }
        }
        throw error;
    }
}

export function sha256(content: string): string {
    return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function fileSnapshotsEqual(left: FileSnapshot, right: FileSnapshot): boolean {
    if (left.kind !== right.kind) {
        return false;
    }
    if (left.kind === 'file' && right.kind === 'file') {
        return left.content === right.content;
    }

    return true;
}

export function settingSnapshotsEqual(left: SettingSnapshot, right: SettingSnapshot): boolean {
    if (left.configured !== right.configured) {
        return false;
    }
    if (left.configured && right.configured) {
        return left.value === right.value;
    }

    return true;
}

export function beginSetupState(
    existing: SetupState | undefined,
    globalConfigPath: string,
    originalGlobalConfig: StoredFileSnapshot,
    originalPhpactorPath: SettingSnapshot,
    installDir: string,
    setupVersion: string,
): SetupState {
    if (existing !== undefined) {
        return {
            ...existing,
            setupVersion,
            original: {
                globalConfigPath: existing.managed.globalConfig === undefined
                    ? globalConfigPath
                    : existing.original.globalConfigPath,
                globalConfig: existing.managed.globalConfig === undefined
                    ? originalGlobalConfig
                    : existing.original.globalConfig,
                phpactorPath: existing.managed.phpactorPath === undefined
                    ? originalPhpactorPath
                    : existing.original.phpactorPath,
            },
            managed: { ...existing.managed, installDir },
        };
    }

    return {
        schemaVersion: SETUP_STATE_SCHEMA_VERSION,
        setupVersion,
        original: {
            globalConfigPath,
            globalConfig: originalGlobalConfig,
            phpactorPath: originalPhpactorPath,
        },
        managed: { installDir },
    };
}

export function recordManagedGlobalConfig(
    state: SetupState,
    pathName: string,
    configBeforeSetup: StoredFileSnapshot,
    managedContent: string,
): SetupState {
    const previous = state.managed.globalConfig;
    const previousManaged: FileSnapshot | undefined = previous === undefined
        ? undefined
        : { kind: 'file', content: previous.content };
    const changedSinceEarlierSetup = previousManaged !== undefined
        && !fileSnapshotsEqual(configBeforeSetup, previousManaged)
        && !fileSnapshotsEqual(configBeforeSetup, state.original.globalConfig);

    return {
        ...state,
        managed: {
            ...state.managed,
            globalConfig: {
                path: pathName,
                content: managedContent,
                sha256: sha256(managedContent),
                userChangesSeen: (previous?.userChangesSeen ?? false) || changedSinceEarlierSetup,
            },
        },
    };
}

export function recordManagedPhpactorPath(
    state: SetupState,
    pathBeforeSetup: SettingSnapshot,
    managedPath: string,
): SetupState {
    const previous = state.managed.phpactorPath;
    const changedSinceEarlierSetup = previous !== undefined
        && !settingSnapshotsEqual(pathBeforeSetup, { configured: true, value: previous.value })
        && !settingSnapshotsEqual(pathBeforeSetup, state.original.phpactorPath);

    return {
        ...state,
        managed: {
            ...state.managed,
            phpactorPath: {
                value: managedPath,
                userChangesSeen: (previous?.userChangesSeen ?? false) || changedSinceEarlierSetup,
            },
        },
    };
}

export function globalConfigRestoreDisposition(
    state: SetupState,
    current: FileSnapshot,
): RestoreDisposition {
    const managed = state.managed.globalConfig;
    if (managed === undefined) {
        return 'already-restored';
    }
    if (fileSnapshotsEqual(current, state.original.globalConfig)) {
        return 'already-restored';
    }
    if (managed.userChangesSeen) {
        return 'conflict';
    }
    if (fileSnapshotsEqual(current, { kind: 'file', content: managed.content })) {
        return 'restore';
    }

    return 'conflict';
}

export function phpactorPathRestoreDisposition(
    state: SetupState,
    current: SettingSnapshot,
): RestoreDisposition {
    const managed = state.managed.phpactorPath;
    if (managed === undefined) {
        return 'already-restored';
    }
    if (settingSnapshotsEqual(current, state.original.phpactorPath)) {
        return 'already-restored';
    }
    if (managed.userChangesSeen) {
        return 'conflict';
    }
    if (settingSnapshotsEqual(current, { configured: true, value: managed.value })) {
        return 'restore';
    }

    return 'conflict';
}

/**
 * Re-evaluate a restore against the snapshot shown to the user. A forced
 * conflict restore is valid only while that exact snapshot is still current.
 */
export function globalConfigRestoreWriteDisposition(
    state: SetupState,
    confirmed: FileSnapshot,
    current: FileSnapshot,
    allowConfirmedConflict: boolean,
): RestoreWriteDisposition {
    if (!fileSnapshotsEqual(confirmed, current)) {
        return 'changed-after-confirmation';
    }

    const disposition = globalConfigRestoreDisposition(state, current);
    return disposition === 'conflict' && allowConfirmedConflict ? 'restore' : disposition;
}

export function phpactorPathRestoreWriteDisposition(
    state: SetupState,
    confirmed: SettingSnapshot,
    current: SettingSnapshot,
    allowConfirmedConflict: boolean,
): RestoreWriteDisposition {
    if (!settingSnapshotsEqual(confirmed, current)) {
        return 'changed-after-confirmation';
    }

    const disposition = phpactorPathRestoreDisposition(state, current);
    return disposition === 'conflict' && allowConfirmedConflict ? 'restore' : disposition;
}

export function restoreGlobalConfig(
    file: string,
    original: StoredFileSnapshot,
    expectedCurrent: FileSnapshot,
): void {
    const current = readFileSnapshot(file);
    if (!fileSnapshotsEqual(current, expectedCurrent)) {
        throw new Error(`Refusing to restore global config changed after confirmation: ${file}`);
    }
    if (current.kind === 'other') {
        throw new Error(`Refusing to replace non-file global config: ${file}`);
    }

    if (original.kind === 'file') {
        atomicWriteTextFile(file, original.content);
        return;
    }

    if (current.kind === 'file') {
        fs.unlinkSync(file);
        flushDirectory(path.dirname(file));
    }
}

export function removeManagedInstallDirectory(storageRoot: string, installDir: string): void {
    const expected = path.resolve(storageRoot, 'phpactor-global');
    const actual = path.resolve(installDir);
    if (actual !== expected || actual === path.parse(actual).root) {
        throw new Error(`Refusing to remove unexpected install directory: ${installDir}`);
    }

    fs.rmSync(actual, { recursive: true, force: true });
}

export function parsePhpVersionProbe(output: string): PhpVersionProbe {
    const [versionIdText, version] = output.trim().split(/\r?\n/, 2);
    if (versionIdText === undefined || !/^\d+$/.test(versionIdText) || version === undefined || version === '') {
        throw new Error('PHP version probe returned an unexpected response');
    }

    return { versionId: Number(versionIdText), version };
}

export function isSupportedPhpVersion(versionId: number): boolean {
    return Number.isInteger(versionId) && versionId >= MINIMUM_PHP_VERSION_ID;
}

export function parseSetupState(value: unknown): SetupState | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!isRecord(value)
        || value.schemaVersion !== SETUP_STATE_SCHEMA_VERSION
        || typeof value.setupVersion !== 'string'
        || !isRecord(value.original)
        || typeof value.original.globalConfigPath !== 'string'
        || !isStoredFileSnapshot(value.original.globalConfig)
        || !isSettingSnapshot(value.original.phpactorPath)
        || !isRecord(value.managed)
    ) {
        throw new Error('保存されたrestore stateの形式またはschema versionを認識できません。');
    }

    const managed = value.managed;
    if (managed.installDir !== undefined && typeof managed.installDir !== 'string') {
        throw new Error('保存されたrestore stateのinstall directoryが不正です。');
    }
    if (managed.phpactorPath !== undefined && !isManagedPhpactorPath(managed.phpactorPath)) {
        throw new Error('保存されたrestore stateのphpactor.pathが不正です。');
    }
    if (managed.globalConfig !== undefined && !isManagedGlobalConfig(managed.globalConfig)) {
        throw new Error('保存されたrestore stateのglobal config情報が不正です。');
    }

    return value as unknown as SetupState;
}

function parseJsonObject(content: string, label: string): Record<string, unknown> {
    let value: unknown;
    try {
        value = JSON.parse(content);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${label} is not valid JSON: ${detail}`);
    }
    if (!isRecord(value)) {
        throw new Error(`${label} must contain a JSON object`);
    }

    return value;
}

function flushDirectory(directory: string): void {
    let descriptor: number | undefined;
    try {
        descriptor = fs.openSync(directory, 'r');
        fs.fsyncSync(descriptor);
    } catch {
        // Some platforms/filesystems do not support fsync on directories.
        // The file itself was still flushed before rename.
    } finally {
        if (descriptor !== undefined) {
            fs.closeSync(descriptor);
        }
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStoredFileSnapshot(value: unknown): value is StoredFileSnapshot {
    return isRecord(value)
        && (value.kind === 'missing' || (value.kind === 'file' && typeof value.content === 'string'));
}

function isSettingSnapshot(value: unknown): value is SettingSnapshot {
    return isRecord(value)
        && (value.configured === false
            || (value.configured === true && (typeof value.value === 'string' || value.value === null)));
}

function isManagedGlobalConfig(value: unknown): value is ManagedGlobalConfig {
    return isRecord(value)
        && typeof value.path === 'string'
        && typeof value.content === 'string'
        && typeof value.sha256 === 'string'
        && value.sha256 === sha256(value.content)
        && typeof value.userChangesSeen === 'boolean';
}

function isManagedPhpactorPath(value: unknown): value is ManagedPhpactorPath {
    return isRecord(value)
        && typeof value.value === 'string'
        && typeof value.userChangesSeen === 'boolean';
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && 'code' in error;
}
