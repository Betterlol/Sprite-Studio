import { useEffect, useRef, useState } from "react";
import { Save, Scissors, RefreshCw } from "lucide-react";
import { assetUrl, type Asset, type ImageAsset } from "../studio/model.ts";
import type { SheetDocument, SheetRecipe } from "../studio/sheets.ts";
import { api } from "./api.ts";
import { sheetRecipeSchema } from "../studio/sheet-schema.ts";

export function SliceConfigPanel({
  projectId,
  image,
  assets,
  refreshToken,
  onRefresh,
  onSelect,
  onGrid,
  gridVisible,
  onGridVisible,
  disabled,
}: {
  projectId: string;
  image: ImageAsset;
  assets: Asset[];
  refreshToken: string;
  onRefresh: () => Promise<void>;
  onSelect: (id: string) => void;
  onGrid: (grid: SheetRecipe["slicing"]["grid"] | null) => void;
  gridVisible: boolean;
  onGridVisible: (visible: boolean) => void;
  disabled: boolean;
}) {
  const [document, setDocument] = useState<SheetDocument | null>(null),
    [text, setText] = useState(""),
    [base, setBase] = useState("missing");
  const [external, setExternal] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [details, setDetails] = useState(false);
  const local = useRef({
    loaded: false,
    text: "",
    base: "missing",
    savedText: "",
  });
  const storageKey = `studio.recipe.${projectId}.${image.id}`;
  useEffect(() => {
    let cancelled = false;
    void api<SheetDocument>(`/api/projects/${projectId}/documents/${image.id}`)
      .then((next) => {
        if (cancelled) return;
        setDocument(next);
        if (!local.current.loaded) {
          let draft: { text: string; base: string } | null = null;
          try {
            draft = JSON.parse(sessionStorage.getItem(storageKey) || "null");
          } catch {}
          const value = draft || {
            text: next.text,
            base: next.documentRevision,
          };
          local.current = { loaded: true, ...value, savedText: next.text };
          setText(value.text);
          setBase(value.base);
          setExternal(value.base !== next.documentRevision);
        } else if (
          local.current.text === local.current.savedText ||
          local.current.text === next.text
        ) {
          local.current.text = next.text;
          local.current.savedText = next.text;
          setText(next.text);
          local.current.base = next.documentRevision;
          setBase(next.documentRevision);
          setExternal(false);
        } else if (local.current.base !== next.documentRevision) {
          setExternal(true);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, image.id, refreshToken]);
  let recipe: SheetRecipe | null = null;
  try {
    const parsed = sheetRecipeSchema.safeParse(JSON.parse(text));
    if (parsed.success) recipe = parsed.data;
  } catch {}
  useEffect(() => {
    onGrid(recipe?.slicing.grid || null);
  }, [text]);
  function edit(value: string) {
    setText(value);
    local.current.text = value;
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({ text: value, base: local.current.base }),
    );
  }
  function grid(columns: number, rows: number) {
    if (!recipe) return;
    const next = structuredClone(recipe);
    next.slicing.grid.columns = columns;
    next.slicing.grid.rows = rows;
    edit(JSON.stringify(next, null, 2) + "\n");
  }
  function initialize() {
    if (!recipe) return;
    const next = structuredClone(recipe),
      old = next.slicing.items;
    next.slicing.items = Array.from(
      { length: next.slicing.grid.columns * next.slicing.grid.rows },
      (_, index) => {
        const x = index % next.slicing.grid.columns,
          y = Math.floor(index / next.slicing.grid.columns);
        return (
          old.find((item) => item.cell[0] === x && item.cell[1] === y) || {
            cell: [x, y],
            name: String(index + 1).padStart(2, "0"),
            enabled: true,
          }
        );
      },
    );
    edit(JSON.stringify(next, null, 2) + "\n");
  }
  async function save() {
    if (!document) return;
    setBusy(true);
    setError("");
    try {
      const [next] = await api<SheetDocument[]>(
        `/api/projects/${projectId}/documents`,
        {
          method: "POST",
          body: JSON.stringify({
            documents: [
              { documentId: image.id, expectedDocumentRevision: base, text },
            ],
          }),
        },
      );
      setDocument(next!);
      setText(next!.text);
      setBase(next!.documentRevision);
      setExternal(false);
      local.current = {
        loaded: true,
        text: next!.text,
        base: next!.documentRevision,
        savedText: next!.text,
      };
      sessionStorage.removeItem(storageKey);
      await onRefresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function execute() {
    if (!document) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/projects/${projectId}/assets/${image.id}/slice-config`, {
        method: "POST",
        body: JSON.stringify({
          expectedDefinitionRevision: document.definitionRevision,
          requestId: crypto.randomUUID(),
        }),
      });
      const next = await api<SheetDocument>(
        `/api/projects/${projectId}/documents/${image.id}`,
      );
      setDocument(next);
      await onRefresh();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const dirty = !!document && text !== document.text;
  const outputs = (document?.outputIds || []).flatMap((id) => {
    const asset = assets.find((a) => a.id === id);
    return asset?.type === "image" ? [asset] : [];
  });
  return (
    <div className="slice-config-panel">
      <div className="tool-content">
        <label>
          列
          <input
            aria-label="切割列数"
            type="number"
            min="1"
            max="32"
            value={recipe?.slicing.grid.columns || 1}
            disabled={!recipe || busy}
            onChange={(e) =>
              grid(
                Math.max(1, Math.min(32, Number(e.target.value))),
                recipe!.slicing.grid.rows,
              )
            }
          />
        </label>
        <label className="grid-toggle">
          <input
            type="checkbox"
            checked={gridVisible}
            onChange={(e) => onGridVisible(e.target.checked)}
          />
          网格
        </label>
        <span>×</span>
        <label>
          行
          <input
            aria-label="切割行数"
            type="number"
            min="1"
            max="32"
            value={recipe?.slicing.grid.rows || 1}
            disabled={!recipe || busy}
            onChange={(e) =>
              grid(
                recipe!.slicing.grid.columns,
                Math.max(1, Math.min(32, Number(e.target.value))),
              )
            }
          />
        </label>
        <button
          className="secondary"
          disabled={
            !recipe ||
            busy ||
            disabled ||
            recipe.slicing.grid.columns * recipe.slicing.grid.rows > 128
          }
          onClick={initialize}
        >
          从全部网格初始化
        </button>
        <button
          className="secondary"
          disabled={!document || busy || disabled || external}
          onClick={() => void save()}
        >
          <Save size={14} />
          保存配置
        </button>
        <button
          className="secondary"
          disabled={!document?.exists || busy || disabled || external || dirty}
          onClick={() => void execute()}
        >
          <Scissors size={14} />
          {busy ? "处理中…" : "执行切割"}
        </button>
      </div>
      <div className="slice-config-summary">
        <span>
          {external
            ? "配置有新版本，本地草稿已保留"
            : dirty
              ? "有未保存修改"
              : document?.status === "ready"
                ? "切片已更新"
                : document?.exists
                  ? "配置未应用"
                  : "尚未保存配置"}
        </span>
        <span>
          {recipe?.slicing.items.filter((item) => item.enabled).length || 0}{" "}
          个单元 · 切割不自动创建动画
        </span>
        <button onClick={() => setDetails(!details)}>
          {details ? "收起配置正文" : "编辑配置正文"}
        </button>
      </div>
      {external && (
        <p className="slice-config-error" role="alert">
          请先复制需要保留的草稿，再读取新版本；系统不会覆盖你的编辑。
          <button
            onClick={() => {
              if (document) {
                edit(document.text);
                setBase(document.documentRevision);
                local.current.base = document.documentRevision;
                local.current.savedText = document.text;
                setExternal(false);
                sessionStorage.removeItem(storageKey);
              }
            }}
          >
            <RefreshCw size={12} />
            读取新版本
          </button>
        </p>
      )}
      {details && (
        <label className="slice-config-document">
          切割配置 JSON
          <textarea
            aria-label="切割配置正文"
            value={text}
            onChange={(e) => edit(e.target.value)}
            spellCheck={false}
          />
          <small>
            {document?.path} · margin
            顺序：上、右、下、左；spacing：横、纵。修改单元时保留已有 id。
          </small>
        </label>
      )}
      {error && (
        <p className="slice-config-error" role="alert">
          {error}
        </p>
      )}
      {!!outputs.length && (
        <div className="slice-output-list" aria-label="切割结果">
          {outputs.map((output) => (
            <button
              key={output.id}
              title={output.name}
              onClick={() => onSelect(output.id)}
            >
              <img
                src={assetUrl(projectId, output.id, output.revision)}
                alt={output.name}
              />
              <span>{output.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
