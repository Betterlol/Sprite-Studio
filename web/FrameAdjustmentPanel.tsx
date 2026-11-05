import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import {
  type ClipReview,
  frameEditSchema,
  type ClipAsset,
  type ClipSnapshot,
  type FrameDraft,
  type RenderWarning,
} from "../studio/model.ts";
import type { z } from "zod";

type Config = z.infer<typeof frameEditSchema>;
type Document = {
  documentId: string;
  documentRevision: string;
  text: string;
  draft: FrameDraft;
};
export type FramePreview = {
  draft: FrameDraft;
  before: ClipSnapshot;
  preview: ClipSnapshot;
  modified: boolean;
  modifiedFrameIds: string[];
  warnings: RenderWarning[];
};
export function FrameAdjustmentPanel(props: {
  projectId: string;
  clip: ClipAsset;
  frameId: string;
  playing: boolean;
  drafts: FrameDraft[];
  onPreview: (value: FramePreview | null) => void;
  onRefresh: () => Promise<void>;
}) {
  const [doc, setDoc] = useState<Document | null>(null),
    [config, setConfig] = useState<Config | null>(null);
  const [target, setTarget] = useState(props.frameId),
    [error, setError] = useState("");
  const [readyText, setReadyText] = useState(""),
    [busy, setBusy] = useState(false);
  const [evidence, setEvidence] = useState<ClipReview | null>(null);
  const [modified, setModified] = useState(false);
  const [changedFrames, setChangedFrames] = useState<string[]>([]),
    [warnings, setWarnings] = useState<RenderWarning[]>([]);
  const modifiedRef = useRef(false);
  const current = useRef<Document | null>(null),
    queue = useRef(Promise.resolve());
  const onPreview = useRef(props.onPreview);
  onPreview.current = props.onPreview;
  const wasPlaying = useRef(props.playing);
  useEffect(() => {
    if (!props.playing && !wasPlaying.current) setTarget(props.frameId);
    wasPlaying.current = props.playing;
  }, [props.frameId, props.playing]);
  const url = `/api/projects/${props.projectId}`;
  function load(value: Document) {
    modifiedRef.current = false;
    current.current = value;
    setDoc(value);
    setConfig(JSON.parse(value.text));
    setReadyText("");
    setModified(false);
    setError("");
    setEvidence(null);
    setWarnings([]);
    setChangedFrames([]);
  }
  useEffect(() => {
    let cancelled = false;
    if (
      current.current &&
      modifiedRef.current &&
      current.current.draft.source === "human"
    ) {
      setError(
        "已保存动画发生变化；你的整份草稿已保留，保存前需要处理版本冲突。",
      );
      return;
    }
    current.current = null;
    setDoc(null);
    setConfig(null);
    onPreview.current(null);
    if (!props.frameId) return;
    const request = api<Document>(`${url}/frame-drafts`, {
      method: "POST",
      body: JSON.stringify({
        clipId: props.clip.id,
        revision: props.clip.revision,
        frameId: props.frameId,
      }),
    });
    void request
      .then((value) => {
        if (!cancelled) load(value);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [props.projectId, props.clip.id, props.clip.revision]);
  useEffect(() => {
    if (!doc || !config) return;
    let cancelled = false;
    const documentId = doc.documentId,
      text = JSON.stringify(config);
    setEvidence(null);
    const timer = setTimeout(() => {
      queue.current = queue.current
        .catch(() => {})
        .then(async () => {
          if (cancelled || current.current?.documentId !== documentId) return;
          setError("");
          try {
            let latest = current.current;
            if (JSON.stringify(JSON.parse(latest.text)) !== text) {
              const result = await api<Document[]>(`${url}/documents`, {
                method: "POST",
                body: JSON.stringify({
                  documents: [
                    {
                      documentId,
                      expectedDocumentRevision: latest.documentRevision,
                      text,
                    },
                  ],
                }),
              });
              latest = result[0]!;
              if (current.current?.documentId !== documentId) return;
              current.current = latest;
            }
            if (cancelled) return;
            const result = await api<FramePreview>(
              `${url}/frame-drafts/${documentId}/preview`,
              {
                method: "POST",
                body: JSON.stringify({
                  documentRevision: latest.documentRevision,
                }),
              },
            );
            if (cancelled) return;
            setDoc(latest);
            setReadyText(text);
            setModified(result.modified);
            modifiedRef.current = result.modified;
            setChangedFrames(result.modifiedFrameIds);
            setWarnings(result.warnings);
            onPreview.current(result.modified ? result : null);
          } catch (e: any) {
            if (!cancelled) {
              setError(e.message);
              setReadyText("");
            }
          }
        });
    }, 160);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [config, doc?.documentId]);
  // Follow Agent edits while viewing its draft, without overwriting a human's inputs.
  const remote = props.drafts.find((d) => d.id === doc?.documentId);
  useEffect(() => {
    if (
      remote?.source === "agent" &&
      remote.documentRevision !== current.current?.documentRevision
    )
      load({
        documentId: remote.id,
        documentRevision: remote.documentRevision,
        text: remote.text,
        draft: remote,
      });
  }, [remote?.documentRevision]);
  const pending = remote?.status === "pending",
    agent = doc?.draft.source === "agent";
  const frameNumber = props.clip.frames.findIndex((f) => f.id === target) + 1;
  const selectedConfig = config?.frames.find((f) => f.frameId === target);
  async function action(kind: "save" | "discard") {
    if (!current.current) return;
    setBusy(true);
    setError("");
    try {
      const value = current.current;
      await api(`${url}/frame-drafts/${value.documentId}/${kind}`, {
        method: "POST",
        body: JSON.stringify({ documentRevision: value.documentRevision }),
      });
      onPreview.current(null);
      current.current = null;
      setDoc(null);
      setConfig(null);
      await props.onRefresh();
      if (kind === "discard")
        load(
          await api<Document>(`${url}/frame-drafts`, {
            method: "POST",
            body: JSON.stringify({
              clipId: props.clip.id,
              revision: props.clip.revision,
              frameId: target,
            }),
          }),
        );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function open(draft: FrameDraft) {
    try {
      load(await api<Document>(`${url}/documents/${draft.id}`));
    } catch (e: any) {
      setError(e.message);
    }
  }
  async function inspect() {
    const latest = current.current;
    if (!latest) return;
    try {
      const result = await api<FramePreview>(
        `${url}/frame-drafts/${latest.documentId}/preview`,
        {
          method: "POST",
          body: JSON.stringify({ documentRevision: latest.documentRevision }),
        },
      );
      onPreview.current(result);
      const index = result.preview.clip.frames.findIndex(
        (f) => f.id === result.draft.frameId,
      );
      const frames = result.preview.clip.frames;
      const review = await api<ClipReview>(`${url}/reviews`, {
        method: "POST",
        body: JSON.stringify({
          snapshotId: result.preview.id,
          draftId: latest.documentId,
          documentRevision: latest.documentRevision,
          startFrameId: frames[Math.max(0, index - 1)]!.id,
          endFrameId: frames[Math.min(frames.length - 1, index + 1)]!.id,
        }),
      });
      if (current.current?.documentRevision === latest.documentRevision)
        setEvidence(review);
    } catch (e: any) {
      setError(e.message);
    }
  }
  const change = (next: Config["frames"][number]) => {
    if (!config) return;
    setReadyText("");
    modifiedRef.current = true;
    setConfig({
      ...config,
      frames: config.frames.map((f) => (f.frameId === target ? next : f)),
    });
  };
  return (
    <div className="frame-adjustment">
      <div className="frame-draft-heading">
        <strong>动画调整 · 正在编辑第 {frameNumber} 帧</strong>
        <span>
          {pending
            ? "等待保存审批"
            : agent
              ? "助手草稿"
              : modified
                ? "未保存草稿"
                : "帧配置"}
        </span>
      </div>
      {!!props.drafts.filter((d) => d.clipId === props.clip.id).length && (
        <div className="frame-draft-list">
          {props.drafts
            .filter((d) => d.clipId === props.clip.id)
            .map((d) => (
              <button
                className="text-button"
                key={d.id}
                onClick={() => void open(d)}
              >
                {d.source === "agent" ? "助手" : "我的"}草稿 · 动画
                {d.status === "pending" ? " · 待审批" : ""}
              </button>
            ))}
        </div>
      )}
      {config && selectedConfig && (
        <>
          <fieldset
            disabled={busy || pending || agent}
            className="frame-config-fields"
          >
            <label>
              缩放 %
              <input
                aria-label="帧缩放百分比"
                type="number"
                min="5"
                max="400"
                value={selectedConfig.transform.scale * 100}
                onChange={(e) =>
                  change({
                    ...selectedConfig,
                    transform: {
                      ...selectedConfig.transform,
                      scale: Number(e.target.value) / 100,
                    },
                  })
                }
              />
            </label>
            <label>
              水平位移
              <input
                aria-label="帧水平位移"
                type="number"
                value={selectedConfig.transform.offsetX}
                onChange={(e) =>
                  change({
                    ...selectedConfig,
                    transform: {
                      ...selectedConfig.transform,
                      offsetX: Number(e.target.value),
                    },
                  })
                }
              />
            </label>
            <label>
              垂直位移
              <input
                aria-label="帧垂直位移"
                type="number"
                value={selectedConfig.transform.offsetY}
                onChange={(e) =>
                  change({
                    ...selectedConfig,
                    transform: {
                      ...selectedConfig.transform,
                      offsetY: Number(e.target.value),
                    },
                  })
                }
              />
            </label>
            <label>
              时长 ms
              <input
                aria-label="帧时长毫秒"
                type="number"
                min="1"
                max="60000"
                value={selectedConfig.durationUs / 1000}
                onChange={(e) =>
                  change({
                    ...selectedConfig,
                    durationUs: Math.round(Number(e.target.value) * 1000),
                  })
                }
              />
            </label>
            <label className="frame-clip-check">
              <input
                type="checkbox"
                checked={selectedConfig.transform.clip}
                onChange={(e) =>
                  change({
                    ...selectedConfig,
                    transform: {
                      ...selectedConfig.transform,
                      clip: e.target.checked,
                    },
                  })
                }
              />
              允许裁切画布外内容
            </label>
          </fieldset>
          <div className="frame-draft-actions">
            {!agent && (
              <button
                className="primary"
                disabled={
                  busy ||
                  pending ||
                  !modified ||
                  warnings.some((w) => w.blocking) ||
                  !readyText ||
                  readyText !== JSON.stringify(config)
                }
                onClick={() => void action("save")}
              >
                保存全部帧调整
              </button>
            )}
            {!pending && (
              <button
                className="text-button"
                disabled={busy}
                onClick={() => void action("discard")}
              >
                放弃全部调整
              </button>
            )}
            <button
              className="text-button"
              disabled={!readyText || readyText !== JSON.stringify(config)}
              onClick={() => void inspect()}
            >
              查看帧图与叠图
            </button>
            <span role="status">
              {busy
                ? "正在保存…"
                : error
                  ? "预览未更新"
                  : readyText === JSON.stringify(config)
                    ? modified
                      ? "已预览整份草稿，可播放检查"
                      : "与已保存配置一致"
                    : "正在更新预览…"}
            </span>
          </div>
        </>
      )}
      {!!changedFrames.length && (
        <p className="adjust-note">
          已调整 {changedFrames.length} 帧：
          {changedFrames
            .map((id) => props.clip.frames.findIndex((f) => f.id === id) + 1)
            .join("、")}
          。切换帧会保留这些修改，一起播放、保存或放弃。
        </p>
      )}
      {readyText === JSON.stringify(config) &&
        warnings.map((w) => (
          <p key={w.frameId} className="interpolation-warning" role="alert">
            第 {w.frameNumber} 帧超出画布（
            {Object.entries(w.overflow)
              .filter(([, v]) => v)
              .map(
                ([k, v]) =>
                  `${({ left: "左", right: "右", top: "上", bottom: "下" } as const)[k as "left"]}${v}px`,
              )
              .join("，")}
            ）。
            {w.blocking
              ? "预览显示画布内部分；请调整参数或允许裁切后再保存。"
              : "已允许裁切，预览与保存均使用画布内部分。"}
          </p>
        ))}
      {evidence && (
        <div className="frame-draft-evidence">
          <img
            src={`${url}/reviews/${evidence.id}/contact`}
            alt="草稿逐帧检查图"
          />
          <img
            src={`${url}/reviews/${evidence.id}/onion`}
            alt="草稿相邻帧重叠图"
          />
        </div>
      )}
      <p className="adjust-note">
        整份动画草稿基于源图片渲染，不新增素材。
        {agent
          ? "助手提交后，可一次批准或拒绝整份草稿。"
          : "所有帧修改一起预览；确认后统一保存，原配置在保存前保持不变。"}
      </p>
      {error && (
        <p className="interpolation-warning" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
