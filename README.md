# Phpactor Setup for BEAR.Sunday

BEAR.Sunday プロジェクト向けに phpactor と、BEAR.Sunday の規約を phpactor に教える Composer パッケージ（suzumaze/bear-phpactor-extension）をVS Codeで使えるようにする、セットアップ専用の薄い拡張機能です。

## これが何か

この拡張は、対象プロジェクトの `composer.json` に一切触れずに、phpactor と対象パッケージをグローバルインストールします。機能そのもの（定義ジャンプなど）は実装していません。あくまでセットアップの代行だけを行います。

## 正直な開示

phpactor の公式READMEには次のように明記されています。

> Phpactor is a general tool, it is not intended that it be installed as a project dependency.

この拡張が使う「グローバルインストール方式」は、この方針を尊重しつつ、対象パッケージ側の技術的制約に対応するための工夫です。対象パッケージの phpactor 拡張クラスはブート時に new されるため、対象プロジェクトの `vendor/autoload.php` に依存させずに済ませる必要があります。そのため、phpactor と対象パッケージをプロジェクト外（グローバル）にインストールし、phpactor のグローバル設定から対象パッケージを読み込む方式を取っています。

## 使い方

対象の BEAR.Sunday プロジェクトを VS Code で開くと、「BEAR.Sundayプロジェクトを検出しました。定義ジャンプなどの機能をセットアップしますか？」という通知が自動で表示されます。「セットアップする」を選ぶだけで完了します。このプロジェクトでは今後確認したくない場合は「今後確認しない」を選んでください。

通知を見逃した場合や、あとから再セットアップしたい場合は、コマンドパレット(⇧⌘P / Ctrl+Shift+P で開く、キーボードだけで機能を呼び出せる入力欄)から「Phpactor Setup for BEAR.Sunday: このプロジェクト向けにセットアップ」を実行することもできます。

`bear/resource` を require（または require-dev）に持つプロジェクトでしか動作しません。

## IDEA（PhpStorm）向けに何も無い理由

同じ目的の、より機能が多く活発に開発されているプラグイン [idea-php-bearsunday-plugin](https://github.com/bearsunday/idea-php-bearsunday-plugin) が既に存在するため、車輪の再発明を避けました。PhpStorm を使っている場合はそちらを利用してください。

## 既知の制約

セットアップは `phpactor.path` をユーザー設定（User settings）に書き込みます。この拡張でセットアップした後は、他のPHPプロジェクトを開いてもこのphpactorパスが使われるようになります（グローバルインストールしたphpactorを全プロジェクトで共有する設計のため、意図した挙動です）。

ただし、対象プロジェクトの `.vscode/settings.json`（プロジェクトだけの設定）に別途 `phpactor.path` が設定されている場合、VS Codeの優先順位によりそちらが勝つため、ユーザー設定を書き換えても反映されないことがあります。上書き確認のダイアログは出ますが、実際に効くのはプロジェクト側の値です。

## サポート体制

個人の趣味プロジェクトであり、ベストエフォートでのサポートです。issue は歓迎しますが、対応は時間が許す範囲になります。
