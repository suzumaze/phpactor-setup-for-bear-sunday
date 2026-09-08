'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const core = require('../out/setup-core.js');

function withTemporaryEnvironment(run) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phpactor-setup-test-'));
    const environment = {
        home: path.join(root, 'home'),
        xdg: path.join(root, 'xdg'),
        workspace: path.join(root, 'workspace'),
        storage: path.join(root, 'storage'),
    };
    for (const directory of Object.values(environment)) {
        fs.mkdirSync(directory, { recursive: true });
    }

    try {
        return run(environment);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
}

function initializedConfig(seedContent) {
    const config = JSON.parse(seedContent);
    config[core.EXTENSION_CLASSES_KEY] = [
        core.BEAR_EXTENSION_CLASS,
        'Phpactor\\Extension\\Core\\CoreExtension',
    ];
    return `${JSON.stringify(config, null, 4)}\n`;
}

test('existing global config is used as seed and all non-BEAR settings survive', () => {
    withTemporaryEnvironment(({ home, xdg, workspace, storage }) => {
        const target = core.globalConfigFile({ XDG_CONFIG_HOME: xdg }, home);
        const original = [
            '{',
            '  "language_server_phpstan.enabled": true,',
            '  "indexer.exclude_patterns": ["/var/cache/**/*"]',
            '}',
            '',
        ].join('\n');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, original);
        fs.writeFileSync(path.join(workspace, 'composer.json'), '{"require":{"bear/resource":"*"}}\n');

        const snapshot = core.readJsonConfigSnapshot(target);
        const seed = core.configSeedContent(snapshot);
        const generated = initializedConfig(seed);
        core.validateGeneratedConfig(seed, generated);

        fs.mkdirSync(storage, { recursive: true });
        core.atomicWriteTextFile(path.join(storage, '.phpactor.json'), seed);
        core.atomicWriteTextFile(target, generated);

        const result = JSON.parse(fs.readFileSync(target, 'utf8'));
        assert.equal(result['language_server_phpstan.enabled'], true);
        assert.deepEqual(result['indexer.exclude_patterns'], ['/var/cache/**/*']);
        assert.equal(
            result[core.EXTENSION_CLASSES_KEY].filter((item) => item === core.BEAR_EXTENSION_CLASS).length,
            1,
        );
    });
});

test('existing BEAR configuration remains de-duplicated after repeated setup', () => {
    withTemporaryEnvironment(({ home, xdg }) => {
        const target = core.globalConfigFile({ XDG_CONFIG_HOME: xdg }, home);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const first = initializedConfig('{"completion_worse.enabled":true}\n');
        fs.writeFileSync(target, first);

        for (let count = 0; count < 2; count += 1) {
            const seed = core.configSeedContent(core.readJsonConfigSnapshot(target));
            const generated = initializedConfig(seed);
            core.validateGeneratedConfig(seed, generated);
            core.atomicWriteTextFile(target, generated);
        }

        const result = JSON.parse(fs.readFileSync(target, 'utf8'));
        assert.equal(result['completion_worse.enabled'], true);
        assert.equal(
            result[core.EXTENSION_CLASSES_KEY].filter((item) => item === core.BEAR_EXTENSION_CLASS).length,
            1,
        );
    });
});

test('invalid existing JSON aborts before a seed is written and remains byte-for-byte unchanged', () => {
    withTemporaryEnvironment(({ home, xdg, storage }) => {
        const target = core.globalConfigFile({ XDG_CONFIG_HOME: xdg }, home);
        const invalid = '{ not json\n';
        const seedFile = path.join(storage, '.phpactor.json');
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, invalid);

        assert.throws(() => core.readJsonConfigSnapshot(target), /not valid JSON/);
        assert.equal(fs.readFileSync(target, 'utf8'), invalid);
        assert.equal(fs.existsSync(seedFile), false);
    });
});

test('relative XDG_CONFIG_HOME is rejected instead of writing below the extension working directory', () => {
    assert.throws(
        () => core.globalConfigFile({ XDG_CONFIG_HOME: 'relative/config' }, '/tmp/fake-home'),
        /absolute path/,
    );
});

test('generated config is rejected if the initializer drops an existing key', () => {
    const seed = '{"language_server_phpstan.enabled":true}\n';
    const generated = initializedConfig('{}\n');

    assert.throws(
        () => core.validateGeneratedConfig(seed, generated),
        /did not preserve existing setting/,
    );
});

test('generated config preserves every existing extension class without merging unknown classes', () => {
    const customClass = 'Acme\\Phpactor\\CustomExtension';
    const seed = JSON.stringify({
        [core.EXTENSION_CLASSES_KEY]: [customClass, core.BEAR_EXTENSION_CLASS],
    });
    const preserved = JSON.stringify({
        [core.EXTENSION_CLASSES_KEY]: [
            core.BEAR_EXTENSION_CLASS,
            customClass,
            'Phpactor\\Extension\\Core\\CoreExtension',
        ],
    });
    const dropped = initializedConfig(seed);

    core.validateGeneratedConfig(seed, preserved);
    assert.throws(
        () => core.validateGeneratedConfig(seed, dropped),
        /did not preserve existing extension class.*Acme/,
    );
});

test('invalid existing extension class setting is rejected instead of overwritten', () => {
    const seed = JSON.stringify({ [core.EXTENSION_CLASSES_KEY]: { custom: true } });

    assert.throws(
        () => core.validateGeneratedConfig(seed, initializedConfig('{}')),
        /existing Phpactor config has no valid.*extension_classes.*list/,
    );
});

test('phpactor.path restores an explicitly configured global value', () => {
    const original = { configured: true, value: '/usr/local/bin/phpactor' };
    let state = core.beginSetupState(
        undefined,
        '/tmp/config/phpactor/phpactor.json',
        { kind: 'missing' },
        original,
        '/tmp/storage/phpactor-global',
        '0.1.0',
    );
    state = core.recordManagedPhpactorPath(
        state,
        original,
        '/tmp/storage/phpactor-global/vendor/bin/phpactor',
    );
    const managed = { configured: true, value: state.managed.phpactorPath.value };

    assert.equal(core.phpactorPathRestoreDisposition(state, managed), 'restore');
    const restored = state.original.phpactorPath;
    assert.deepEqual(restored, original);
    assert.equal(core.phpactorPathRestoreDisposition(state, restored), 'already-restored');
});

test('phpactor.path restores to truly unset when no global value existed', () => {
    let state = core.beginSetupState(
        undefined,
        '/tmp/config/phpactor/phpactor.json',
        { kind: 'missing' },
        { configured: false },
        '/tmp/storage/phpactor-global',
        '0.1.0',
    );
    state = core.recordManagedPhpactorPath(
        state,
        { configured: false },
        '/tmp/storage/phpactor-global/vendor/bin/phpactor',
    );

    assert.equal(
        core.phpactorPathRestoreDisposition(state, { configured: true, value: state.managed.phpactorPath.value }),
        'restore',
    );
    assert.deepEqual(state.original.phpactorPath, { configured: false });
    assert.equal(
        core.phpactorPathRestoreDisposition(state, { configured: false }),
        'already-restored',
    );
});

test('restore detects user edits to config and phpactor.path', () => {
    const originalConfig = { kind: 'file', content: '{"foo":"before"}\n' };
    let state = core.beginSetupState(
        undefined,
        '/tmp/config/phpactor/phpactor.json',
        originalConfig,
        { configured: false },
        '/tmp/storage/phpactor-global',
        '0.1.0',
    );
    state = core.recordManagedGlobalConfig(
        state,
        state.original.globalConfigPath,
        originalConfig,
        initializedConfig(originalConfig.content),
    );
    state = core.recordManagedPhpactorPath(
        state,
        { configured: false },
        '/tmp/storage/phpactor-global/vendor/bin/phpactor',
    );

    assert.equal(
        core.globalConfigRestoreDisposition(state, { kind: 'file', content: '{"foo":"user edit"}\n' }),
        'conflict',
    );
    assert.equal(
        core.phpactorPathRestoreDisposition(state, { configured: true, value: '/custom/phpactor' }),
        'conflict',
    );
});

test('forced restore is rejected when config or phpactor.path changes after confirmation', () => {
    const originalConfig = { kind: 'file', content: '{"foo":"before"}\n' };
    let state = core.beginSetupState(
        undefined,
        '/tmp/config/phpactor/phpactor.json',
        originalConfig,
        { configured: false },
        '/tmp/storage/phpactor-global',
        '0.2.0',
    );
    state = core.recordManagedGlobalConfig(
        state,
        state.original.globalConfigPath,
        originalConfig,
        initializedConfig(originalConfig.content),
    );
    state = core.recordManagedPhpactorPath(
        state,
        { configured: false },
        '/tmp/storage/phpactor-global/vendor/bin/phpactor',
    );

    const confirmedConfig = { kind: 'file', content: '{"foo":"first user edit"}\n' };
    const changedConfig = { kind: 'file', content: '{"foo":"second user edit"}\n' };
    const confirmedPath = { configured: true, value: '/first/user/phpactor' };
    const changedPath = { configured: true, value: '/second/user/phpactor' };

    assert.equal(
        core.globalConfigRestoreWriteDisposition(state, confirmedConfig, confirmedConfig, true),
        'restore',
    );
    assert.equal(
        core.globalConfigRestoreWriteDisposition(state, confirmedConfig, changedConfig, true),
        'changed-after-confirmation',
    );
    assert.equal(
        core.phpactorPathRestoreWriteDisposition(state, confirmedPath, confirmedPath, true),
        'restore',
    );
    assert.equal(
        core.phpactorPathRestoreWriteDisposition(state, confirmedPath, changedPath, true),
        'changed-after-confirmation',
    );
});

test('global config restore checks the expected snapshot again immediately before writing', () => {
    withTemporaryEnvironment(({ xdg, home }) => {
        const target = core.globalConfigFile({ XDG_CONFIG_HOME: xdg }, home);
        const original = { kind: 'file', content: '{"foo":"original"}\n' };
        const confirmed = { kind: 'file', content: '{"foo":"confirmed edit"}\n' };
        const later = '{"foo":"later edit"}\n';
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, later);

        assert.throws(
            () => core.restoreGlobalConfig(target, original, confirmed),
            /changed after confirmation/,
        );
        assert.equal(fs.readFileSync(target, 'utf8'), later);
    });
});

test('repeated setup preserves the original backup and remembers intervening user edits', () => {
    const originalConfig = { kind: 'file', content: '{"foo":"original"}\n' };
    const originalPath = { configured: true, value: '/usr/local/bin/phpactor' };
    let state = core.beginSetupState(
        undefined,
        '/tmp/config/phpactor/phpactor.json',
        originalConfig,
        originalPath,
        '/tmp/storage/phpactor-global',
        '0.1.0',
    );
    const firstManaged = initializedConfig(originalConfig.content);
    state = core.recordManagedGlobalConfig(
        state,
        state.original.globalConfigPath,
        originalConfig,
        firstManaged,
    );
    const managedPath = '/tmp/storage/phpactor-global/vendor/bin/phpactor';
    state = core.recordManagedPhpactorPath(state, originalPath, managedPath);

    const userEdited = { kind: 'file', content: firstManaged.replace('"foo": "original"', '"foo": "edited"') };
    state = core.beginSetupState(
        state,
        state.original.globalConfigPath,
        userEdited,
        { configured: true, value: '/custom/phpactor-after-setup' },
        '/tmp/storage/phpactor-global',
        '0.2.0',
    );
    const secondManaged = initializedConfig(userEdited.content);
    state = core.recordManagedGlobalConfig(
        state,
        state.original.globalConfigPath,
        userEdited,
        secondManaged,
    );
    state = core.recordManagedPhpactorPath(
        state,
        { configured: true, value: '/custom/phpactor-after-setup' },
        managedPath,
    );

    assert.deepEqual(state.original.globalConfig, originalConfig);
    assert.deepEqual(state.original.phpactorPath, originalPath);
    assert.equal(state.managed.globalConfig.userChangesSeen, true);
    assert.equal(
        core.globalConfigRestoreDisposition(state, { kind: 'file', content: secondManaged }),
        'conflict',
    );
    assert.equal(
        core.phpactorPathRestoreDisposition(state, { configured: true, value: managedPath }),
        'conflict',
    );
});

test('setup and restore round-trip global config byte-for-byte in isolated HOME and XDG directories', () => {
    withTemporaryEnvironment(({ home, xdg, storage }) => {
        const target = core.globalConfigFile({ XDG_CONFIG_HOME: xdg, HOME: home }, home);
        const originalContent = '{\r\n  "foo": "bar",\r\n  "list": [1, 2]\r\n}\r\n';
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, originalContent);

        const original = core.readJsonConfigSnapshot(target);
        const generated = initializedConfig(core.configSeedContent(original));
        let state = core.beginSetupState(
            undefined,
            target,
            original,
            { configured: true, value: '/usr/local/bin/phpactor' },
            path.join(storage, 'phpactor-global'),
            '0.1.0',
        );
        state = core.recordManagedGlobalConfig(state, target, original, generated);
        core.atomicWriteTextFile(target, generated);

        assert.equal(core.globalConfigRestoreDisposition(state, core.readFileSnapshot(target)), 'restore');
        core.restoreGlobalConfig(target, state.original.globalConfig, core.readFileSnapshot(target));
        assert.equal(fs.readFileSync(target, 'utf8'), originalContent);
        assert.equal(core.globalConfigRestoreDisposition(state, core.readFileSnapshot(target)), 'already-restored');
    });
});

test('restore removes a generated config when no config existed before setup', () => {
    withTemporaryEnvironment(({ home, xdg }) => {
        const target = core.globalConfigFile({ XDG_CONFIG_HOME: xdg }, home);
        const original = core.readJsonConfigSnapshot(target);
        const generated = initializedConfig(core.configSeedContent(original));
        core.atomicWriteTextFile(target, generated);
        core.restoreGlobalConfig(target, original, core.readFileSnapshot(target));

        assert.equal(fs.existsSync(target), false);
        core.restoreGlobalConfig(target, original, core.readFileSnapshot(target));
        assert.equal(fs.existsSync(target), false);
    });
});

test('managed install removal is confined to phpactor-global under extension storage', () => {
    withTemporaryEnvironment(({ storage }) => {
        const installDir = path.join(storage, 'phpactor-global');
        fs.mkdirSync(path.join(installDir, 'vendor'), { recursive: true });
        fs.writeFileSync(path.join(installDir, 'vendor', 'marker'), 'managed');

        core.removeManagedInstallDirectory(storage, installDir);
        assert.equal(fs.existsSync(installDir), false);
        core.removeManagedInstallDirectory(storage, installDir);
        assert.throws(
            () => core.removeManagedInstallDirectory(storage, path.join(storage, 'something-else')),
            /unexpected install directory/,
        );
    });
});

test('PHP 8.1 is rejected and PHP 8.2 is accepted using PHP_VERSION_ID', () => {
    const php81 = core.parsePhpVersionProbe('80129\n8.1.29');
    const php82 = core.parsePhpVersionProbe('80200\n8.2.0');

    assert.equal(core.isSupportedPhpVersion(php81.versionId), false);
    assert.equal(core.isSupportedPhpVersion(php82.versionId), true);
});

test('Composer manifest pins tested compatibility and prefers stable packages', () => {
    const composer = JSON.parse(core.globalComposerJson());

    assert.equal(composer.require['phpactor/phpactor'], '2026.07.22.0');
    assert.equal(composer.require['phpactor/language-server-protocol'], '3.17.4');
    assert.equal(composer.require['suzumaze/bear-phpactor-extension'], '^0.1.1');
    assert.equal(composer['minimum-stability'], 'dev');
    assert.equal(composer['prefer-stable'], true);
});

test('legacy per-project setup markers are recognized for global migration', () => {
    assert.equal(
        core.hasLegacySetupDoneMarker([
            'unrelated.key',
            `${core.LEGACY_SETUP_DONE_PREFIX}/workspace/project`,
        ]),
        true,
    );
    assert.equal(core.hasLegacySetupDoneMarker([core.SETUP_DONE_KEY]), false);
    assert.equal(core.hasLegacySetupDoneMarker([]), false);
    assert.equal(
        core.hasLegacySkipSetupPromptMarker([
            `${core.LEGACY_SKIP_SETUP_PROMPT_PREFIX}/workspace/project`,
        ]),
        true,
    );
    assert.equal(core.hasLegacySkipSetupPromptMarker([core.SKIP_SETUP_PROMPT_KEY]), false);
});

test('invalid or unknown restore state is rejected instead of replacing its backup', () => {
    assert.throws(
        () => core.parseSetupState({ schemaVersion: 99 }),
        /schema version/,
    );
});
