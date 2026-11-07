import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { atomicJson } from "./store.ts";

export const permissionPolicySchema = z.enum(["allow", "ask", "deny"]);
export type PermissionPolicy = z.infer<typeof permissionPolicySchema>;
export const permissionTools = [
  { name: "read_markdown", label: "读取Markdown文档", detail: "读取当前工程文档正文", writes: false },
  { name: "create_markdown", label: "新建Markdown文档", detail: "在文档分类中新建文件", writes: true },
  { name: "write_markdown", label: "保存Markdown文档", detail: "按确切版本直接保存正文", writes: true },
  {
    name: "save_image",
    label: "添加图片到指定目录",
    detail: "将生成产物保存为参考图或原图素材",
    writes: true,
  },
  {
    name: "create_clip",
    label: "新建动画",
    detail: "在动画目录建立资源",
    writes: true,
  },
  {
    name: "write_documents",
    label: "编辑并保存配置",
    detail: "更新切割、动画编排或帧调整草稿的 JSON 配置",
    writes: true,
  },
  {
    name: "slice_sheet",
    label: "执行切割",
    detail: "按已保存配置创建或更新切片",
    writes: true,
  },
  {
    name: "adjust_image",
    label: "保存调整图片",
    detail: "生成调整后的图片资源",
    writes: true,
  },
  {
    name: "create_frame_draft",
    label: "创建动画调整草稿",
    detail: "创建或复用动画草稿配置",
    writes: true,
  },
  {
    name: "save_frame_draft",
    label: "应用动画帧调整",
    detail: "将整份草稿保存到动画，保留修改记录",
    writes: true,
  },
  {
    name: "list_assets",
    label: "列出资源",
    detail: "读取资源索引",
    writes: false,
  },
  {
    name: "list_generated_images",
    label: "列出生成产物",
    detail: "读取本对话的生成产物",
    writes: false,
  },
  {
    name: "view_image",
    label: "查看图片",
    detail: "读取真实图片像素",
    writes: false,
  },
  {
    name: "get_schema",
    label: "读取配置格式",
    detail: "查看配置字段定义",
    writes: false,
  },
  {
    name: "read_document",
    label: "读取配置",
    detail: "读取资源或草稿的配置全文",
    writes: false,
  },
  {
    name: "validate_document",
    label: "校验配置",
    detail: "检查配置内容，不保存",
    writes: false,
  },
  {
    name: "inspect_sheet",
    label: "检测并预览切割",
    detail: "只读透明连通域和配方证据；继承读取配置与动画检查权限",
    writes: false,
  },
  {
    name: "inspect_clip",
    label: "预览并检查动画",
    detail: "生成逐帧图、叠图与检查记录，不应用草稿",
    writes: false,
  },
  {
    name: "create_clip_draft",
    label: "创建完整动画草稿",
    detail: "显式派生完整编排和参数；继承帧草稿创建权限",
    writes: true,
  },
  {
    name: "save_clip_draft",
    label: "保存完整动画草稿",
    detail: "提交确切对象草稿；继承帧草稿保存权限",
    writes: true,
  },
  {
    name: "review_sequence",
    label: "多动作Review",
    detail: "管理序列和全部批次证据；继承配置或检查权限",
    writes: true,
  },
  {
    name: "workflow_task",
    label: "制作任务检查与交付",
    detail: "读取任务、真实渲染检查或标为可验收；不代替人工接受",
    writes: false,
  },
] as const;
export type PermissionTool = (typeof permissionTools)[number]["name"];
export type ToolPolicies = Record<PermissionTool, PermissionPolicy>;
export const defaultToolPolicies = Object.fromEntries(
  permissionTools.map((t) => [
    t.name,
    t.name === "save_image" ? "ask" : "allow",
  ]),
) as ToolPolicies;
export class ToolPermissions {
  path: string;
  constructor(root: string) {
    this.path = join(root, "tool-permissions.json");
  }
  read(): ToolPolicies {
    if (!existsSync(this.path)) return { ...defaultToolPolicies };
    const data = JSON.parse(readFileSync(this.path, "utf8"));
    // Older versions persisted the frame-save preference as a top-level key.
    const raw = data.schemaVersion === 1 ? data.policies : data;
    return Object.fromEntries(
      permissionTools.map((t) => [
        t.name,
        permissionPolicySchema.parse(
          raw[t.name] ?? defaultToolPolicies[t.name],
        ),
      ]),
    ) as ToolPolicies;
  }
  write(input: unknown): ToolPolicies {
    const schema = z
      .object(
        Object.fromEntries(
          permissionTools.map((t) => [
            t.name,
            permissionPolicySchema.optional(),
          ]),
        ),
      )
      .strict();
    const patch = schema.parse(input);
    const policies = { ...this.read(), ...patch } as ToolPolicies;
    atomicJson(this.path, { schemaVersion: 1, policies });
    return policies;
  }
}
