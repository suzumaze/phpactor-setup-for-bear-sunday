# Phpactor Setup for BEAR.Sunday

BEAR.Sunday固有のIDE/LSP機能を提供するComposerパッケージ
[`suzumaze/bear-phpactor-extension`](https://github.com/suzumaze/bear-phpactor-extension)を、
VS CodeのPhpactorから利用できるようにするセットアップ専用の薄い拡張機能です。

## 目的と責務

この拡張自身はResource URI解析、SQL・ALPS・JSON Schema・Routerの解決、定義ジャンプ、参照検索、補完などを実装しません。BEAR.Sunday固有の知識は`bear-phpactor-extension`に置き、本拡張はVS Code固有のインストールと設定だけを担当します。

```text
BEAR.Sunday固有のIDE/LSP機能
        ↓
bear-phpactor-extension
        ↓
Phpactor / LSP
        ↓
VS Code / Neovim / Emacs / その他LSP client

VS Code固有のセットアップ
        ↓
phpactor-setup-for-bear-sunday
```

## Phpactorについて

[Phpactor](https://phpactor.readthedocs.io/)は、PHPの定義ジャンプ、補完、リファクタリングなどをLSPで提供するLanguage Serverです。VS Codeでは、公式拡張[`phpactor.vscode-phpactor`](https://marketplace.visualstudio.com/items?itemName=phpactor.vscode-phpactor)がPhpactorを起動し、PHP文書とLSP requestを送受信します。

本拡張はPhpactorやそのVS Codeクライアントを置き換えません。本拡張の役割は、互換性を確認したPhpactorと`bear-phpactor-extension`を専用領域へインストールし、公式Phpactor拡張がそのPhpactorを使うよう`phpactor.path`を設定することです。そのため、本拡張だけを有効にしても定義ジャンプは動作せず、公式Phpactor拡張がインストール済みかつ有効である必要があります。

公式Phpactor拡張はextension packとして一緒にインストールされます。ただし、過去にユーザーが無効化した拡張を本拡張から再度有効化することは、VS Codeの公開APIではできません。無効な場合は表示される「Phpactorを確認・有効化」から拡張画面を開き、手動で有効化してウィンドウを再読み込みしてください。

対象プロジェクトの`composer.json`や`.vscode/settings.json`は変更しません。Phpactorと`bear-phpactor-extension`は本拡張の`globalStorageUri`配下へインストールし、次の2点だけをglobalに反映します。

- `$XDG_CONFIG_HOME/phpactor/phpactor.json`（未設定時は`~/.config/phpactor/phpactor.json`）
- VS Code User Settingsの`phpactor.path`

これは1つのworkspace専用設定ではありません。同じローカルVS Code環境では初回の1回だけ案内し、複数のBEAR.Sundayプロジェクトから同じ管理対象Phpactor installationを共有する設計です。VS Codeの別プロファイル、Insiders、SSHやDev Containerなどのremote環境は別の環境として扱われます。

## 要件

- PHP 8.2以上
- Composer
- VS Code 1.91以上（依存する`phpactor.vscode-phpactor` 1.7.8と同じminimum）
- Phpactor公式VS Code拡張（extension packとしてインストールされますが、有効化されている必要があります）

PHPはComposer実行前に`PHP_VERSION_ID`で検査し、8.2未満なら環境を変更せず終了します。

## 使い方

`bear/resource`を`require`または`require-dev`に持つプロジェクトを開くと、未セットアップの場合だけ、グローバルセットアップであることを明記した確認通知が表示されます。別のBEARプロジェクトを開いても再表示しません。コマンドパレットから手動実行することもでき、手動実行ではBEARプロジェクトを開いていなくても明示確認後に続行できます。

```text
Phpactor Setup for BEAR.Sunday: グローバルセットアップ
```

`bear-phpactor-extension`の新しい互換バージョンが公開された場合、セットアップ拡張を再インストールする必要はありません。次のコマンドを明示的に実行すると、管理対象Composer projectのlockを更新し、このセットアップ拡張が許可する互換範囲内の最新版を取得して設定を再生成します。

```text
Phpactor Setup for BEAR.Sunday: 管理対象パッケージを更新
```

通常の再セットアップは既存の`composer.lock`を再現し、意図しない自動更新を行いません。互換範囲を越えるバージョンは、セットアップ拡張側で互換性を確認して依存条件を更新した新しいリリースが必要です。

### VS CodeでTwigジャンプを試す

現在のPhpactor公式VS Code clientは、標準では`php`と`blade`文書だけをLanguage Serverへ送信します。Twigファイルも送信する暫定策として、BEARプロジェクトの`.vscode/settings.json`へ次を追加できます。

```json
{
    "files.associations": {
        "*.html.twig": "php"
    }
}
```

これにより`.html.twig`がPHP文書としてPhpactorへ送信され、Twig内の対応構文からジャンプできます。ただし、VS Code上の言語モードもPHPになるため、Twigのsyntax highlight、diagnostics、formatter、他のTwig拡張の挙動へ影響する可能性があります。標準対応ではなくworkspace限定の暫定策として使用し、不都合があれば設定を削除してください。Qiqは`.php`ファイルなので追加設定は不要です。

`.html.twig`はTwigそのものが要求する拡張子ではありません。この設定は、[BEAR.Sunday公式TwigModuleの標準的なResourceテンプレート配置](https://bearsunday.github.io/manuals/1.0/ja/html-twig-v2.html)に合わせたもので、任意のTwigプロジェクトや独自loader設定まで対象にするものではありません。「ジャンプ」はVS Codeの「定義へ移動」操作を指します。右クリックメニューやコマンドパレットから実行でき、`F12`はその既定ショートカットにすぎません。

setup後にPhpactorを元の状態へ戻す場合は、次を実行します。

```text
Phpactor Setup for BEAR.Sunday: グローバルセットアップを元に戻す
```

Phpactor公式VS Code拡張が無効な場合、`phpactor.path`はVS Codeへ登録されません。その場合は変更を始める前に処理を止め、Phpactor拡張の役割と必要な操作を説明して、拡張画面を開く案内を表示します。

## 非破壊setupとrestore

初回setupでは、ユーザー環境へ書き込む前に次の状態を`ExtensionContext.globalState`へ保存します。再setupでこのoriginal backupを現在値に置き換えることはありません。

- global Phpactor configが存在したか、および存在した場合の元の内容
- VS Code User Settingsとして明示されていた`phpactor.path`（`inspect('path').globalValue`）
- `phpactor.path`が未設定だったこと
- 本拡張が書いたconfigの内容とSHA-256
- 本拡張が設定したPhpactor pathと管理対象install directory
- state schema versionとsetup extension version

既存global configは丸ごと置き換えません。setupは次の順序で処理します。

1. 既存configをJSON objectとして検証する。invalid JSON、symlink、通常ファイルでない場合は変更せず中止する。
2. 既存config全体を作業用`.phpactor.json`のseedにする。
3. `bear-phpactor-init`へ`container.extension_classes`の再生成と重複除去を任せる。
4. 生成結果が既存の他キーと既存extension classをすべて保持し、BEAR extension classを先頭に1回だけ含むことを検証する。既存classが生成結果から消えた場合は、別のComposer autoloaderが必要な可能性があるため、独自mergeせずsetupを中止する。
5. setup中の同時変更がないことを再確認し、一時ファイルをflushしてrenameするatomic writeでglobal configへ反映する。

したがって、PHPStan、PHP CS Fixer、indexer、completion等の既存設定は保持されます。既存configが壊れている場合に、勝手な修正・削除・上書きは行いません。

restoreは現在値と「setup時に本拡張が書いた値」を比較します。一致するときだけ自動復元し、元々configがなければ生成ファイルを削除、元々`phpactor.path`が未設定ならUser setting自体を未設定へ戻します。本拡張の管理対象install directoryも削除します。

setup後のユーザー変更を検出した場合は、変更対象を明示したmodal warningを出します。defaultはCancelで、ユーザーが「変更を破棄して復元」を明示的に選んだ場合だけoriginal backupを上書きします。確認時と書き込み直前のsnapshotが異なる場合は、確認後の変更を上書きせず中止します。途中まで復元して失敗した場合も項目ごとに進捗を保存するため、restoreは再実行可能で冪等です。

## Phpactor互換性方針

この拡張が生成するComposer projectは、`phpactor/phpactor`を`2026.07.22.0`へ、`bear-phpactor-extension`を`^0.1.1`へpinします。これは`bear-phpactor-extension` v0.1.1の開発・テスト環境で使われ、Phpactor公式VS Code client 1.7.8も取得しているreleaseです。

Phpactorのversionはリリース日を表すCalVer形式です。日付が新しいことは、内部extension class構成やextension APIとの互換性を保証しません。`bear-phpactor-extension`はその内部構成に依存するため、未検証の将来versionを`*`や`latest`で自動取得せず、検証後にpinを意図的に更新します。

初回解決後の`composer.lock`は管理対象install directoryに保持します。通常の再setupは`composer install`で同じdependency graphを再現し、この拡張がcompatibility manifestを意図的に変更したときだけ`composer update`で再解決します。

`phpactor/language-server-protocol`は`3.17.4`のexact pinを維持します。language-server 7.0.1とprotocol 3.17.5以上の組合せには、未保存変更の`textDocument/didChange`が届かない既知regressionがあります。修正PR [`phpactor/language-server#68`](https://github.com/phpactor/language-server/pull/68)は2025-12-29にmerge済みですが、2026-09-04時点の最新stable tagは修正を含まない7.0.1です。修正版stable releaseへの収録と、pinしたPhpactorとの互換性を確認できるまで解除しません。

Composerの`minimum-stability: dev`も維持します。Phpactor 2026.07.22.0自身が`jetbrains/phpstorm-stubs: dev-master`と`phpactor/tolerant-php-parser: dev-phan-phactor-fixes`をrequireするためです。一方、実際の一時Composer環境で解決できることを確認した上で`prefer-stable: true`とし、それ以外はstable packageを優先します。

## 正直な開示

Phpactorの公式READMEには次のように明記されています。

> Phpactor is a general tool, it is not intended that it be installed as a project dependency.

本拡張はこの方針に沿い、対象プロジェクトのdependencyには追加しません。ただし、Phpactorのboot時に`container.extension_classes`の全classが同じComposer autoloaderから読める必要があるため、本拡張専用のglobal storage内でPhpactorと`bear-phpactor-extension`を一緒に管理します。

## Prior Art（先行プロジェクト）

BEAR.Sunday向けのVS Code支援には、Yuki Adachi氏による[BEAR.Sunday Extension Pack](https://marketplace.visualstudio.com/items?itemName=YukiAdachi.vscode-bear-sunday-extension-pack)という先行プロジェクトがあります。同Extension PackはResource、SQL、Aura Router、Twigなど、BEAR.Sunday開発で必要とされたnavigation機能をVS Code拡張として提供しており、本プロジェクトにとって重要なprior artです。

本プロジェクトはそれを置き換えるものではありません。先行方式にはinstallが単純でdependencyが少なく、VS Codeだけを対象とする場合に直接的という利点があります。本プロジェクトは、現在のPhpactor/LSP extension architectureを使い、framework固有の知識をLanguage Server側へ集約する別の構成です。definitionに加えてcompletion、references、type definition等へ展開しやすく、NeovimやEmacsを含む他のLSP clientからも利用できます。

`bear-phpactor-extension` v0.1.1はTwig/QiqのBEAR固有navigationをLanguage Server側に実装します。ただし、現在のPhpactor公式VS Code clientはTwig文書をLanguage Serverへ送信しないため、標準セットアップのVS CodeではTwig上のジャンプを利用できません。Qiqは`.php`文書として送信されるため利用できます。先行Extension Packを置き換えるものではなく、LSP clientが対象文書を送信できる場合に利用する、アーキテクチャの異なる選択肢です。

## IDEA（PhpStorm）

同じ問題領域には、より機能が多く活発に開発されている[`idea-php-bearsunday-plugin`](https://github.com/bearsunday/idea-php-bearsunday-plugin)があります。PhpStormではそちらを利用してください。

## 既知の制約

- global setupなので、User Settingsの`phpactor.path`はBEAR.Sunday以外のworkspaceにも影響します。
- global Phpactor configへBEAR extension classを登録するため、別のPhpactor installationが同じconfigを読む場合は、そのComposer autoloaderからclassを読み込めるか注意が必要です。既存extension classを管理対象installationで再生成できない場合、本拡張は黙って削除せずsetupを中止します。
- WorkspaceまたはWorkspace Folderに別の`phpactor.path`がある場合はVS Codeの優先順位でそちらが勝ちます。本拡張はUser settingだけを保存・復元し、workspace設定は変更しません。
- setup済みの状態で`XDG_CONFIG_HOME`を変えると、誤った場所へbackupを復元しないよう再setupを中止します。元の環境でrestoreしてからやり直してください。
- backup機能導入前の旧版ですでにsetup済みの場合、旧版が介入する前の状態は遡って復元できません。初回更新時に警告し、その時点のconfigとUser settingを復元基準として保存します。
- setup後のconfigをsemantic mergeで巻き戻すことはしません。後編集があれば自動restoreを止め、明示確認を求めます。
- uninstall時の自動restoreは行いません。拡張を削除する前にrestore commandを実行してください。
- global install方式は現在macOSの1環境でのみ実機確認済みです。Linuxは未確認で、WindowsではPhpactor公式clientがWSLまたはLinux VMの利用を案内しています。
- 現在のPhpactor公式VS Code clientはTwig文書を標準ではLanguage Serverへ送信しません。`files.associations`でTwigをPHPとして送る暫定策は利用できますが、言語モードへの影響があります。本来の対応にはclient側のdocument selector対応が必要です。

## サポート体制

個人の趣味プロジェクトであり、ベストエフォートでのサポートです。issueやpull requestは歓迎しますが、対応の保証はありません。Phpactor upstreamの内部構成変更により、pin更新には追加検証が必要になる場合があります。
