'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const manifest = require('../package.json');

test('clean uninstall keeps the existing command id and exposes the new title', () => {
    const command = manifest.contributes.commands.find(
        (candidate) => candidate.command === 'phpactorSetup.restore',
    );

    assert.notEqual(command, undefined);
    assert.equal(
        command.title,
        'Phpactor Setup for BEAR.Sunday: クリーンアンインストール',
    );
});
