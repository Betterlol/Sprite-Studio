import { api } from "./api.ts";
import { reviewArchivePayload, type ArchivableReviewDefinition } from "./workflow-state.ts";

/** Reversible metadata action only; never deletes definitions, assets or snapshots. */
export async function setReviewArchived(projectId: string, definition: ArchivableReviewDefinition | undefined, expectedRevision: string, dirty: boolean, archived: boolean): Promise<ArchivableReviewDefinition> {
  const body = reviewArchivePayload(definition, expectedRevision, dirty, archived);
  const next = await api<ArchivableReviewDefinition>(`/api/projects/${projectId}/review-sequences/${definition!.id}/archive`, {
    method: "POST", body: JSON.stringify(body),
  });
  if (next.id !== definition!.id || next.projectId !== projectId || !!next.archived !== archived) throw new Error("Review 归档响应身份/状态不匹配，输入已保留");
  return next;
}
