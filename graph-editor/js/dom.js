    const $ = (id) => document.getElementById(id);
    const dom = {
      // 一覧 / キャンバス / パネル
      list: $("fileList"),
      canvas: $("canvas"),
      canvasPane: $("canvasPane"),
      inspectorBody: $("inspectorBody"),
      // トップバー / ステータス
      status: $("status"),
      fileChip: $("fileChip"),
      btnUndo: $("btnUndo"),
      btnRedo: $("btnRedo"),
      // 操作ボタン
      btnSave: $("btnSave"),
      btnReset: $("btnResetAll"),
      btnZoomIn: $("btnZoomIn"),
      btnZoomOut: $("btnZoomOut"),
      // ウィザード
      stepbar: $("stepbar"),
      scOpen: $("scOpen"),
      scEdit: $("scEdit"),
      scSave: $("scSave"),
      dropzone: $("dropzone"),
      btnPick: $("btnPick"),
      btnOpenRail: $("btnOpenRail"),
      btnBack: $("btnBack"),
      btnNext: $("btnNext"),
      navHint: $("navHint"),
      toast: $("toast"),
      // 表示まわり
      openList: $("openList"),
      openCount: $("openCount"),
      pgInfo: $("pgInfo"),
      zoomLvl: $("zoomLvl"),
      saveName: $("saveName"),
      saveSub: $("saveSub"),
    };

export { $, dom };
