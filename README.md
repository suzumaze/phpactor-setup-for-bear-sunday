# Phpactor Setup for BEAR.Sunday

[VS Code](https://code.visualstudio.com/)で[`suzumaze/bear-phpactor-extension`](https://github.com/suzumaze/bear-phpactor-extension)を使うためのセットアップ拡張です。

[BEAR.Sunday](https://bearsunday.github.io/manuals/1.0/ja/)固有の定義ジャンプ、参照検索、補完は`bear-phpactor-extension`が[Phpactor](https://phpactor.readthedocs.io/) / [LSP](https://microsoft.github.io/language-server-protocol/)上で提供します。この拡張は、それらを再実装せず、VS Code向けのインストールと設定だけを担当します。

```text
VS Code
  ↓ Phpactor公式VS Code拡張
Phpactor / LSP
  ↓
bear-phpactor-extension
```

## 必要なもの

- [VS Code](https://code.visualstudio.com/) 1.91以上
- [PHP](https://www.php.net/) 8.2以上
- [Composer](https://getcomposer.org/)
- [Phpactor公式VS Code拡張](https://marketplace.visualstudio.com/items?itemName=phpactor.vscode-phpactor)

Phpactor公式拡張はextension packとして一緒にインストールされます。無効化されている場合は、拡張画面から有効化してVS Codeを再読み込みしてください。

## コマンドの実行方法

1. macOSでは`Shift+Command+P`、Windows/Linuxでは`Ctrl+Shift+P`を押して[コマンドパレット](https://code.visualstudio.com/docs/getstarted/userinterface#_command-palette)を開きます。
2. `Phpactor Setup for BEAR.Sunday`と入力します。
3. 表示されたコマンドを選んで実行します。

このREADMEに記載する拡張コマンドは、すべてこの手順で実行します。ターミナルやPhpactor CLIへ入力するコマンドではありません。

## セットアップ

[`bear/resource`](https://packagist.org/packages/bear/resource)を`require`または`require-dev`に持つプロジェクトを開くと、未セットアップの場合だけ案内が表示されます。「セットアップする」を選び、完了後にVS Codeを再読み込みしてください。

手動で実行する場合は、コマンドパレットから次を選びます。

```text
Phpactor Setup for BEAR.Sunday: グローバルセットアップ
```

同じローカルVS Code環境では一度だけ必要です。設定したPhpactorは複数のBEAR.Sundayプロジェクトで共有されます。VS Codeのプロファイル、Insiders、SSH、Dev Containerはそれぞれ別環境です。

## コアの確認と更新

現在使用中の`bear-phpactor-extension`を確認するには、次を実行します。

```text
Phpactor Setup for BEAR.Sunday: 使用中のコアバージョンを確認
```

表示された通知の「コアを更新」ボタン、または次のコマンドから、互換範囲内の最新版へ更新できます。

```text
Phpactor Setup for BEAR.Sunday: コアを更新
```

更新後はVS Codeを再読み込みしてください。この操作が更新するのは`bear-phpactor-extension`とその依存パッケージだけです。Phpactor本体、`phpactor.path`、Phpactorのグローバル設定は変更しません。

現在の対応範囲は`^0.1.3`です。`0.1.x`はセットアップ拡張を入れ直さず更新できます。互換範囲を越えるリリースには、対応版のセットアップ拡張が必要です。

## TwigとQiq

[BEAR.SundayのHTMLマニュアル](https://bearsunday.github.io/manuals/1.0/ja/html.html)では、HTMLテンプレートエンジンとしてQiqとTwigが案内されています。

[Qiq](https://bearsunday.github.io/manuals/1.0/ja/html-qiq.html)テンプレートは`.php`ファイルなので、通常どおりPhpactorへ送信されます。

Phpactor公式VS Codeクライアントは、[Twig](https://bearsunday.github.io/manuals/1.0/ja/html-twig-v2.html)文書を標準ではLanguage Serverへ送りません。BEAR標準配置の`.html.twig`を試す場合は、プロジェクトの`.vscode/settings.json`へ次を追加します。

```json
{
    "files.associations": {
        "*.html.twig": "php"
    }
}
```

これはTwigをPHP文書として送る暫定策です。言語モードがPHPになるため、Twigのsyntax highlight、診断、formatter、他のTwig拡張へ影響する場合があります。不都合があれば設定を削除してください。

`.html.twig`はTwig必須の拡張子ではなく、BEAR.Sunday TwigModuleの標準配置に合わせた指定です。対応するジャンプ構文は[`bear-phpactor-extension`のREADME](https://github.com/suzumaze/bear-phpactor-extension#readme)を参照してください。

## 変更する場所

対象プロジェクトの`composer.json`や`.vscode/settings.json`は変更しません。Phpactorとコアは、この拡張の`globalStorageUri`配下へインストールします。

グローバルに変更するのは次の2点です。

- `$XDG_CONFIG_HOME/phpactor/phpactor.json`（通常は`~/.config/phpactor/phpactor.json`）
- VS Code User Settingsの`phpactor.path`

既存のPhpactor設定は保持し、BEAR.Sunday拡張クラスだけを追加します。不正なJSON、symlink、通常ファイルでない設定、処理中の同時変更を検出した場合は、上書きせず中止します。

## 元に戻す

セットアップ前のPhpactor設定と`phpactor.path`は、初回変更前に保存されます。元に戻す場合は、拡張をアンインストールする前に次を実行してください。

```text
Phpactor Setup for BEAR.Sunday: グローバルセットアップを元に戻す
```

現在値がセットアップ時の値と一致する場合だけ自動復元します。セットアップ後のユーザー変更を検出した場合は、破棄するか確認し、確認後に値が変わった場合も上書きしません。管理対象のインストールディレクトリも復元時に削除します。

## バージョン方針

管理対象Composer環境は、動作確認した組み合わせを固定します。

| パッケージ | バージョン |
|---|---|
| `phpactor/phpactor` | `2026.07.22.0` |
| `phpactor/language-server-protocol` | `3.17.4` |
| `suzumaze/bear-phpactor-extension` | `^0.1.3` |

Phpactorは内部extension APIの互換性を常に保証するわけではないため、未検証の最新版へ自動追従しません。通常の再セットアップは`composer.lock`を再現し、「コアを更新」を実行した場合だけコアを互換範囲内で更新します。

`phpactor/language-server-protocol`は、未保存変更の`textDocument/didChange`に関する既知の組み合わせを避けるため`3.17.4`へ固定しています。修正済みstable releaseとPhpactorの互換性を確認後に更新します。関連: [`phpactor/language-server#68`](https://github.com/phpactor/language-server/pull/68)

Phpactorはプロジェクトdependencyとしてではなく、この拡張専用の領域へインストールします。これは[Phpactor公式のインストール方針](https://github.com/phpactor/phpactor#installation)に沿ったものです。

## 既知の制約

- `phpactor.path`はUser Settingsへ書くため、BEAR.Sunday以外のワークスペースにも影響します。
- WorkspaceまたはWorkspace Folderに別の`phpactor.path`があれば、VS Codeの優先順位でそちらが使われます。
- Phpactor公式拡張が無効な場合、この拡張から有効化することはできません。
- セットアップ後に`XDG_CONFIG_HOME`を変えた場合は、元の環境で復元してから再セットアップしてください。
- アンインストール時の自動復元は行いません。
- 現在の実機確認はmacOSのみです。Linuxは未確認です。Windowsでは[Phpactor公式クライアント](https://github.com/phpactor/vscode-phpactor#readme)がWSLまたはLinux VMを案内しています。
- Twigの制約は[「TwigとQiq」](#twigとqiq)のとおりです。

## 関連プロジェクト

- [bear-phpactor-extension](https://github.com/suzumaze/bear-phpactor-extension): BEAR.Sunday固有のPhpactor/LSP機能
- [BEAR.Sunday Extension Pack](https://marketplace.visualstudio.com/items?itemName=YukiAdachi.vscode-bear-sunday-extension-pack): VS Code APIで実装された先行プロジェクト
- [idea-php-bearsunday-plugin](https://github.com/bearsunday/idea-php-bearsunday-plugin): PhpStorm向けプラグイン

本プロジェクトは先行プロジェクトを置き換えるものではありません。BEAR.Sunday固有の意味をLanguage Server側へ置き、複数のLSPクライアントから利用する別の構成です。
