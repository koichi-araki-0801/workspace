"""辞書の永続化 (JSON ファイル)。

exe と同じフォルダの `data/dictionary.json` に保存する (config 側でパス決定)。
人が直接開いて編集・差分管理・共有できる形式 ``[{"source","target","enabled","joined"}]``
(``joined`` は折返し連結由来の印。旧形式のキー無しは False として読む)。
SQLite からの移行: バックエンドのみ差し替え、公開 API は据え置き
(`add/upsert/update/delete/all/lookup/export_json/import_json/close`)。

実装方針: 起動時にファイルを読み込みメモリ上で操作し、変更のたびにアトミック保存する。
単一ユーザーのデスクトップ用途のため、これで十分かつ堅牢。
"""
from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional

from .normalize import DEFAULT_OPTIONS, NormOptions, normalize


@dataclass
class Mapping:
    """辞書 1 エントリ。`source_raw` は入力原文、`target` は置換後、`enabled` で適用可否。

    `joined` は「元の語が折返し 2 行の連結取り込み由来か」の記録。一括適用の連結照合
    (`lookup_wrap`) はこのフラグ付きエントリにのみ一致させ、単独行で登録した語が
    偶然連結形と一致して意図せず 2 行を畳む事故を防ぐ。
    """

    id: int
    source_raw: str
    target: str
    enabled: bool = True
    joined: bool = False


class DictionaryStore:
    """JSON ファイルを正典とするインメモリ辞書ストア (CRUD + 正規化 lookup)。"""

    def __init__(self, json_path: Path, options: NormOptions = DEFAULT_OPTIONS):
        self.path = Path(json_path)
        self.options = options
        self._mappings: List[Mapping] = []
        self._next_id = 1
        self._index: Dict[str, Mapping] = {}  # source_norm -> Mapping (enabled のみ)
        self._load()

    def close(self) -> None:
        """API 互換のため残す。変更のたびに保存済みなので no-op。"""

    # ── 読み込み / 保存 ──
    def _load(self) -> None:
        """JSON ファイルを読み込み `_mappings` を復元する (壊れていても起動は止めない)。"""
        self._mappings = []
        self._next_id = 1
        if self.path.exists():
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                data = []  # 壊れていても起動を止めない
            for item in data if isinstance(data, list) else []:
                src = item.get("source", "")
                if not src:
                    continue
                self._mappings.append(
                    Mapping(
                        id=self._next_id,
                        source_raw=src,
                        target=item.get("target", ""),
                        enabled=bool(item.get("enabled", True)),
                        # 旧形式 (キー無し) は非連結として読む (後方互換)
                        joined=bool(item.get("joined", False)),
                    )
                )
                self._next_id += 1
        self._rebuild_index()

    def _rebuild_index(self) -> None:
        """`source_norm` → `Mapping` の lookup インデックスを enabled 分のみで再構築する。"""
        self._index = {}
        for m in self._mappings:
            if m.enabled:
                # 後勝ち: 同一正規化キーが複数あれば最後の有効分を採用
                self._index[normalize(m.source_raw, self.options)] = m

    def _save(self) -> None:
        """全 `_mappings` を JSON へアトミック保存する (temp → `os.replace`)。"""
        data = [
            {"source": m.source_raw, "target": m.target, "enabled": m.enabled,
             "joined": m.joined}
            for m in self._mappings
        ]
        text = json.dumps(data, ensure_ascii=False, indent=2)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        # アトミック書き込み (temp → replace) で破損を防ぐ
        fd, tmp = tempfile.mkstemp(dir=str(self.path.parent), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(text)
            os.replace(tmp, self.path)
        except BaseException:
            if os.path.exists(tmp):
                os.remove(tmp)
            raise

    def _find_by_norm(self, source_raw: str) -> Optional[Mapping]:
        """`source_raw` の正規化キーに一致する最初の `Mapping` を返す (無ければ None)。"""
        norm = normalize(source_raw, self.options)
        for m in self._mappings:
            if normalize(m.source_raw, self.options) == norm:
                return m
        return None

    # ── CRUD ──
    def add(
        self, source_raw: str, target: str, enabled: bool = True, joined: bool = False
    ) -> int:
        """新規エントリを追加し採番した `id` を返す。"""
        m = Mapping(
            id=self._next_id, source_raw=source_raw, target=target,
            enabled=enabled, joined=joined,
        )
        self._next_id += 1
        self._mappings.append(m)
        self._rebuild_index()
        self._save()
        return m.id

    def upsert(self, source_raw: str, target: str, joined: bool = False) -> int:
        """同じ正規化キーがあれば target と joined を更新、無ければ追加。"""
        existing = self._find_by_norm(source_raw)
        if existing is not None:
            existing.target = target
            existing.source_raw = source_raw
            existing.joined = joined
            self._rebuild_index()
            self._save()
            return existing.id
        return self.add(source_raw, target, joined=joined)

    def update(self, mid: int, source_raw: str, target: str, enabled: bool) -> None:
        """`id` が `mid` のエントリを全フィールド更新する。"""
        for m in self._mappings:
            if m.id == mid:
                m.source_raw = source_raw
                m.target = target
                m.enabled = enabled
                break
        self._rebuild_index()
        self._save()

    def delete(self, mid: int) -> None:
        """`id` が `mid` のエントリを削除する。"""
        self._mappings = [m for m in self._mappings if m.id != mid]
        self._rebuild_index()
        self._save()

    def all(self) -> List[Mapping]:
        """全エントリを `source_raw` 昇順のコピーで返す (内部状態は不変)。"""
        return sorted(
            (
                Mapping(m.id, m.source_raw, m.target, m.enabled, m.joined)
                for m in self._mappings
            ),
            key=lambda m: m.source_raw,
        )

    def lookup(self, text: str) -> Optional[str]:
        """正規化キー一致で target を返す (enabled のみ)。"""
        m = self._index.get(normalize(text, self.options))
        return m.target if m is not None else None

    def lookup_wrap(self, text: str) -> Optional[str]:
        """連結由来 (`joined=True`) エントリに限って target を返す (enabled のみ)。

        折返し 2 行の連結照合専用。単独行として登録した語が偶然連結形と一致しても
        ここでは引かず、意図して連結取り込みした語だけが 2 行畳み込みの対象になる。
        """
        m = self._index.get(normalize(text, self.options))
        return m.target if (m is not None and m.joined) else None

    # ── JSON 入出力 (共有用。実体ファイルと同形式) ──
    def export_json(self, path: Path) -> None:
        """全エントリを `path` へ JSON 書き出しする (実体ファイルと同形式)。"""
        data = [
            {"source": m.source_raw, "target": m.target, "enabled": m.enabled,
             "joined": m.joined}
            for m in self.all()
        ]
        Path(path).write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def import_json(self, path: Path) -> int:
        """`path` の JSON を `upsert` で取り込み、取り込んだ件数を返す。"""
        try:
            data = json.loads(Path(path).read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            raise ValueError(f"辞書ファイルを読み込めません: {exc}") from exc
        count = 0
        for item in data if isinstance(data, list) else []:
            if not isinstance(item, dict):
                continue
            src = item.get("source", "").strip()
            tgt = item.get("target", "").strip()
            if src:
                self.upsert(src, tgt, joined=bool(item.get("joined", False)))
                count += 1
        return count
