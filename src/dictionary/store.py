"""辞書の永続化 (JSON ファイル)。

exe と同じフォルダの `data/dictionary.json` に保存する (config 側でパス決定)。
人が直接開いて編集・差分管理・共有できる形式 ``[{"source","target","enabled"}]``。
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
    id: int
    source_raw: str
    target: str
    enabled: bool = True


class DictionaryStore:
    def __init__(self, json_path: Path, options: NormOptions = DEFAULT_OPTIONS):
        self.path = Path(json_path)
        self.options = options
        self._mappings: List[Mapping] = []
        self._next_id = 1
        self._index: Dict[str, str] = {}  # source_norm -> target (enabled のみ)
        self._load()

    def close(self) -> None:
        """API 互換のため残す。変更のたびに保存済みなので no-op。"""

    # ---- 読み込み / 保存 ----
    def _load(self) -> None:
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
                    )
                )
                self._next_id += 1
        self._rebuild_index()

    def _rebuild_index(self) -> None:
        self._index = {}
        for m in self._mappings:
            if m.enabled:
                # 後勝ち: 同一正規化キーが複数あれば最後の有効分を採用
                self._index[normalize(m.source_raw, self.options)] = m.target

    def _save(self) -> None:
        data = [
            {"source": m.source_raw, "target": m.target, "enabled": m.enabled}
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
        norm = normalize(source_raw, self.options)
        for m in self._mappings:
            if normalize(m.source_raw, self.options) == norm:
                return m
        return None

    # ---- CRUD ----
    def add(self, source_raw: str, target: str, enabled: bool = True) -> int:
        m = Mapping(id=self._next_id, source_raw=source_raw, target=target, enabled=enabled)
        self._next_id += 1
        self._mappings.append(m)
        self._rebuild_index()
        self._save()
        return m.id

    def upsert(self, source_raw: str, target: str) -> int:
        """同じ正規化キーがあれば target を更新、無ければ追加。"""
        existing = self._find_by_norm(source_raw)
        if existing is not None:
            existing.target = target
            existing.source_raw = source_raw
            self._rebuild_index()
            self._save()
            return existing.id
        return self.add(source_raw, target)

    def update(self, mid: int, source_raw: str, target: str, enabled: bool) -> None:
        for m in self._mappings:
            if m.id == mid:
                m.source_raw = source_raw
                m.target = target
                m.enabled = enabled
                break
        self._rebuild_index()
        self._save()

    def delete(self, mid: int) -> None:
        self._mappings = [m for m in self._mappings if m.id != mid]
        self._rebuild_index()
        self._save()

    def all(self) -> List[Mapping]:
        return sorted(
            (Mapping(m.id, m.source_raw, m.target, m.enabled) for m in self._mappings),
            key=lambda m: m.source_raw,
        )

    def lookup(self, text: str) -> Optional[str]:
        """正規化キー一致で target を返す (enabled のみ)。"""
        return self._index.get(normalize(text, self.options))

    # ---- JSON 入出力 (共有用。実体ファイルと同形式) ----
    def export_json(self, path: Path) -> None:
        data = [
            {"source": m.source_raw, "target": m.target, "enabled": m.enabled}
            for m in self.all()
        ]
        Path(path).write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def import_json(self, path: Path) -> int:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        count = 0
        for item in data:
            src = item.get("source", "")
            tgt = item.get("target", "")
            if src:
                self.upsert(src, tgt)
                count += 1
        return count
