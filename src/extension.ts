import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

const BEAR_RESOURCE_PACKAGE = 'bear/resource';
const GLOBAL_DIR_NAME = 'phpactor-global';
const INIT_BIN = 'bear-phpactor-init';
const PHPACTOR_BIN_REL = path.join('vendor', 'bin', 'phpactor');
const GLOBAL_CONFIG_REL = path.join('phpactor', 'phpactor.json');

// 自動検出とコマンド実行が同時に走ったときに runSetup が二重実行されないようにする。
let setupRunning = false;

/**
 * globalState に「セットアップ済み」を記録するキー。
 * ワークスペースフォルダの絶対パスを含め、プロジェクトごとに状態を分ける。
 */
function setupDoneKey(projectPath: string): string {
    return `phpactorSetup.setupDone:${projectPath}`;
}

/**
 * globalState に「今後確認しない」を記録するキー。
 * ワークスペースフォルダの絶対パスを含め、プロジェクトごとに状態を分ける。
 */
function skipPromptKey(projectPath: string): string {
    return `phpactorSetup.skipPrompt:${projectPath}`;
}

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand('phpactorSetup.setup', () => runSetup(context)),
    );
    // ワークスペースを開いたときに BEAR.Sunday プロジェクトを自動検出して確認する。
    void promptForSetupIfNeeded(context);
}

export function deactivate(): void {
    // 解放するリソースはない
}

interface BearProject {
    folder: vscode.WorkspaceFolder;
}

/**
 * 開いているワークスペースから BEAR.Sunday プロジェクトを探す。
 * composer.json の require / require-dev に bear/resource があれば対象。
 */
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
            continue; // composer.json が無い・読めないフォルダは対象外
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
 * PATH から実行可能ファイルを探す。GUI から起動した VS Code は PATH が
 * 最小限のことがあるので、Homebrew の標準位置も候補に足す。
 */
function findExecutable(bin: string): string | undefined {
    const pathDirs = (process.env.PATH ?? '')
        .split(path.delimiter)
        .filter((dir) => dir !== '');
    const candidates = [...pathDirs, '/opt/homebrew/bin', '/usr/local/bin'];
    for (const dir of candidates) {
        const candidate = path.join(dir, bin);
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return candidate;
        } catch {
            // 次の候補へ
        }
    }
    return undefined;
}

function execFileAsync(
    cmd: string,
    args: string[],
    options: cp.ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
    // Promise.withResolvers は Node 20 系の拡張ホストに無いため使わない。
    return new Promise((resolve, reject) => {
        cp.execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
            if (error !== null) {
                const detail = String(stderr).trim();
                reject(new Error(detail !== '' ? `${error.message}\n${detail}` : error.message));
            } else {
                resolve({ stdout: String(stdout), stderr: String(stderr) });
            }
        });
    });
}

/**
 * phpactor のグローバル設定ファイルの場所。
 * $XDG_CONFIG_HOME/phpactor/phpactor.json（無ければ ~/.config/phpactor/phpactor.json）。
 */
function globalConfigFile(): string {
    const xdg = process.env.XDG_CONFIG_HOME;
    const base = xdg !== undefined && xdg !== '' ? xdg : path.join(os.homedir(), '.config');
    return path.join(base, GLOBAL_CONFIG_REL);
}

/**
 * グローバルインストール用 composer.json。
 * phpactor/language-server-protocol の 3.17.4 ピンは必須（外すと initialize が
 * エラーになる。実験で確認済み）。suzumaze/bear-phpactor-extension は Packagist
 * に公開済みなので、通常のバージョン指定で取得する。
 */
function globalComposerJson(): string {
    const composer = {
        'minimum-stability': 'dev',
        'prefer-stable': false,
        require: {
            php: '^8.2',
            'phpactor/phpactor': '*',
            'phpactor/language-server-protocol': '3.17.4',
            'suzumaze/bear-phpactor-extension': '^0.1',
        },
    };
    return JSON.stringify(composer, null, 4) + '\n';
}

/**
 * bear-phpactor-init の実体を探す。composer の bin プロキシが先、
 * 無ければパッケージ内の実ファイル。
 */
function resolveInitBin(globalDir: string): string | undefined {
    const candidates = [
        path.join(globalDir, 'vendor', 'bin', INIT_BIN),
        path.join(globalDir, 'vendor', 'suzumaze', 'bear-phpactor-extension', 'bin', INIT_BIN),
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return undefined;
}

/**
 * ワークスペースを開いたときの自動検出＋初回確認。
 * BEAR.Sunday プロジェクトが見つかり、このワークスペースでまだセットアップ済みでも
 * 「今後確認しない」でもなければ、セットアップの確認通知を出す。
 */
async function promptForSetupIfNeeded(context: vscode.ExtensionContext): Promise<void> {
    const project = findBearProject();
    if (project === undefined) {
        return;
    }
    const projectPath = project.folder.uri.fsPath;
    if (context.globalState.get<boolean>(setupDoneKey(projectPath)) === true) {
        return; // このワークスペースではセットアップ済み
    }
    if (context.globalState.get<boolean>(skipPromptKey(projectPath)) === true) {
        return; // このワークスペースでは「今後確認しない」が選ばれている
    }
    const answer = await vscode.window.showInformationMessage(
        'BEAR.Sundayプロジェクトを検出しました。定義ジャンプなどの機能をセットアップしますか？',
        'セットアップする',
        '今回はしない',
        '今後確認しない',
    );
    if (answer === 'セットアップする') {
        // 同じセッションでコマンド実行が先に完了していた場合は再実行しない。
        if (context.globalState.get<boolean>(setupDoneKey(projectPath)) === true) {
            return;
        }
        await runSetup(context);
    } else if (answer === '今後確認しない') {
        await context.globalState.update(skipPromptKey(projectPath), true);
    }
    // 「今回はしない」や通知を閉じた場合は何も記録しない（次回また確認する）。
}

async function runSetup(context: vscode.ExtensionContext): Promise<void> {
    // 自動検出とコマンド実行が同時に起きた場合は片方だけ実行する。
    if (setupRunning) {
        vscode.window.showInformationMessage('セットアップはすでに実行中です。');
        return;
    }
    setupRunning = true;
    try {
        // 1. 対象プロジェクトの判定。BEAR.Sunday でなければはっきり断る。
        const project = findBearProject();
        if (project === undefined) {
            vscode.window.showErrorMessage(
                'このプロジェクトはBEAR.Sundayのプロジェクトではないようです（composer.json の require / require-dev に bear/resource が見つかりません）。セットアップを中止しました。',
            );
            return;
        }
        // 2. 前提ツールの確認。
        const composer = findExecutable('composer');
        if (composer === undefined) {
            vscode.window.showErrorMessage(
                'composer が見つかりません。https://getcomposer.org/download/ の手順でインストールし、PATH を通してください。',
            );
            return;
        }
        const php = findExecutable('php');
        if (php === undefined) {
            vscode.window.showErrorMessage(
                'php が見つかりません。PHP 8.2 以上をインストールし、PATH を通してください。',
            );
            return;
        }

        const globalDir = path.join(context.globalStorageUri.fsPath, GLOBAL_DIR_NAME);
        const phpactorBin = path.join(globalDir, PHPACTOR_BIN_REL);

        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'セットアップ',
                cancellable: false,
            },
            async (progress) => {
                try {
                    // 3. グローバルインストール（初回は composer install、済みなら更新確認）。
                    fs.mkdirSync(globalDir, { recursive: true });
                    fs.writeFileSync(path.join(globalDir, 'composer.json'), globalComposerJson());

                    if (fs.existsSync(phpactorBin)) {
                        const answer = await vscode.window.showInformationMessage(
                            'すでにセットアップされています。更新しますか？',
                            '更新する',
                            'キャンセル',
                        );
                        if (answer !== '更新する') {
                            vscode.window.showInformationMessage('キャンセルしました。既存のインストールをそのまま使います。');
                            return;
                        }
                        progress.report({ message: '更新しています…' });
                        await execFileAsync(composer, ['update', '--no-interaction'], { cwd: globalDir });
                    } else {
                        progress.report({ message: '準備しています（初回は数分かかります）…' });
                        await execFileAsync(composer, ['install', '--no-interaction'], { cwd: globalDir });
                    }

                    // 4. 拡張リスト（69個）を含む .phpactor.json を生成。
                    const initBin = resolveInitBin(globalDir);
                    if (initBin === undefined) {
                        throw new Error(
                            `vendor/bin/${INIT_BIN} が見つかりません。composer install が正しく完了したか確認してください。`,
                        );
                    }
                    progress.report({ message: 'phpactor の拡張リストを生成中…' });
                    await execFileAsync(php, [initBin], {
                        cwd: globalDir,
                        env: { ...process.env, PHPACTOR_BIN: phpactorBin },
                    });

                    // 5. 生成物をグローバル設定へコピー。先客がいたら確認を挟む。
                    const generated = path.join(globalDir, '.phpactor.json');
                    const generatedContent = fs.readFileSync(generated, 'utf8');
                    const targetConfig = globalConfigFile();
                    if (
                        fs.existsSync(targetConfig) &&
                        fs.readFileSync(targetConfig, 'utf8').trim() !== generatedContent.trim()
                    ) {
                        const answer = await vscode.window.showInformationMessage(
                            `${targetConfig} に既存の設定があります。上書きしますか？`,
                            '上書きする',
                            'キャンセル',
                        );
                        if (answer !== '上書きする') {
                            vscode.window.showInformationMessage('キャンセルしました。グローバル設定は変更しません。');
                            return;
                        }
                    }
                    fs.mkdirSync(path.dirname(targetConfig), { recursive: true });
                    fs.writeFileSync(targetConfig, generatedContent);

                    // 6. User 設定（Global）に phpactor.path を書き込む。
                    //    Workspace に書き込むと対象プロジェクトの .vscode/settings.json に
                    //    開発者ローカル環境の絶対パスが残り、チーム開発のリポジトリに
                    //    紛れ込む恐れがある。既に別の値が設定されていれば確認を挟む。
                    progress.report({ message: 'ユーザー設定を更新中…' });
                    const phpactorConfig = vscode.workspace.getConfiguration('phpactor');
                    // phpactor拡張自身のスキーマは phpactor.path の既定値を null と
                    // 宣言している。未設定でも undefined ではなく null が返るため、
                    // どちらも「未設定」として扱う。
                    const existingPath = phpactorConfig.get<string | null>('path');
                    if (existingPath !== undefined && existingPath !== null && existingPath !== phpactorBin) {
                        const answer = await vscode.window.showInformationMessage(
                            `phpactor.path に別の値（${existingPath}）が設定されています。${phpactorBin} に上書きしますか？`,
                            '上書きする',
                            'キャンセル',
                        );
                        if (answer !== '上書きする') {
                            vscode.window.showInformationMessage('キャンセルしました。ユーザー設定は変更しません。');
                            return;
                        }
                    }
                    await phpactorConfig.update('path', phpactorBin, vscode.ConfigurationTarget.Global);

                    // セットアップ完了を記録。次にこのワークスペースを開いても自動確認を出さない。
                    await context.globalState.update(setupDoneKey(project.folder.uri.fsPath), true);

                    // phpactor 拡張には言語サーバー再起動専用のコマンドが無いため、
                    // 設定反映は VS Code のウィンドウ再読み込みで行う。
                    const choice = await vscode.window.showInformationMessage(
                        'セットアップが完了しました。設定を反映するには再読み込みが必要です。',
                        '再読み込み',
                    );
                    if (choice === '再読み込み') {
                        await vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                } catch (error) {
                    const detail = error instanceof Error ? error.message : String(error);
                    vscode.window.showErrorMessage(`セットアップに失敗しました: ${detail}`);
                }
            },
        );
    } finally {
        setupRunning = false;
    }
}
