import { useEffect, useRef, useState } from "react";
import { api } from "./api.ts";
import {
  type ClipReview,
  frameEditSchema,
  type ClipAsset,
  type ClipSnapshot,
  type FrameDraft,
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
    current.current = value;
    setDoc(value);
    setConfig(JSON.parse(value.text));
    setReadyText("");
    setModified(false);
    setError("");
    setEvidence(null);
  }
  useEffect(() => {
    let cancelled = false;
    current.current = null;
    setDoc(null);
    setConfig(null);
    onPreview.current(null);
    if (!target) return;
    const request = api<Document>(`${url}/frame-drafts`, {
      method: "POST",
      body: JSON.stringify({
        clipId: props.clip.id,
        revision: props.clip.revision,
        frameId: target,
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
  }, [props.projectId, props.clip.id, props.clip.revision, target]);
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
  const frameNumber =
    props.clip.frames.findIndex(
      (f) => f.id === (doc?.draft.frameId || target),
    ) + 1;
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
  const change = (next: Config) => {
    setReadyText("");
    setConfig(next);
  };
  return (
    <div className="frame-adjustment">
      <div className="frame-draft-heading">
        <strong>单帧配置 · 第 {frameNumber} 帧</strong>
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
                {d.source === "agent" ? "助手" : "我的"}草稿 · 第{" "}
                {props.clip.frames.findIndex((f) => f.id === d.frameId) + 1} 帧
                {d.status === "pending" ? " · 待审批" : ""}
              </button>
            ))}
        </div>
      )}
      {config && (
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
                value={config.transform.scale * 100}
                onChange={(e) =>
                  change({
                    ...config,
                    transform: {
                      ...config.transform,
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
                value={config.transform.offsetX}
                onChange={(e) =>
                  change({
                    ...config,
                    transform: {
                      ...config.transform,
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
                value={config.transform.offsetY}
                onChange={(e) =>
                  change({
                    ...config,
                    transform: {
                      ...config.transform,
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
                value={config.durationUs / 1000}
                onChange={(e) =>
                  change({
                    ...config,
                    durationUs: Math.round(Number(e.target.value) * 1000),
                  })
                }
              />
            </label>
            <label className="frame-clip-check">
              <input
                type="checkbox"
                checked={config.transform.clip}
                onChange={(e) =>
                  change({
                    ...config,
                    transform: { ...config.transform, clip: e.target.checked },
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
                  !readyText ||
                  readyText !== JSON.stringify(config)
                }
                onClick={() => void action("save")}
              >
                保存帧配置
              </button>
            )}
            {!pending && (
              <button
                className="text-button"
                disabled={busy}
                onClick={() => void action("discard")}
              >
                放弃草稿
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
                      ? "正在预览草稿，可播放检查"
                      : "与已保存配置一致"
                    : "正在更新预览…"}
            </span>
          </div>
        </>
      )}
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
        调整基于源图片，不新增素材。
        {agent
          ? "助手提交保存后，可在对话中批准或拒绝。"
          : "播放检查后再保存，原配置在保存前保持不变。"}
      </p>
      {error && (
        <p className="interpolation-warning" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
