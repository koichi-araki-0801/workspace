"""Web UI レイヤ: QWebEngineView 上のフロントエンドと Python バックエンドの橋渡し。

- ``scheme``  : ``app://`` カスタムスキームで resources/web/ を配信する。
- ``bridge``  : QWebChannel に公開する QObject。JS からの RPC を受ける。
- ``rpc_methods`` : RPC メソッドの実体 (既存 engine/dictionary/export を薄く包む)。
- ``commands`` : 編集操作の QUndoCommand 群 (scene 非依存)。
"""
