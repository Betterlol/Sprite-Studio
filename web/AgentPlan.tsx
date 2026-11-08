import type { Session } from "../studio/model.ts";

const labels = { pending: "待进行", inProgress: "进行中", completed: "已完成" };
export function AgentPlan({ session }: { session: Session }) {
  const plan = session.plan;
  if (!plan?.plan.length) return null;
  const current = plan.turnId === session.turnId && session.status !== "starting";
  const running = current && session.status === "running";
  const count = plan.plan.filter(step => step.status === "completed").length;
  const state = !current ? "上一轮计划" : running ? "执行计划" : session.status === "idle" ? "本轮计划 · 回合已结束" : "本轮计划 · 已停止";
  return <details className="agent-plan" open={running}>
    <summary><span>{state}</span><small>{count}/{plan.plan.length} 步已完成</small></summary>
    {plan.explanation && <p>{plan.explanation}</p>}
    <ol aria-label={state}>
      {plan.plan.map((step, index) => <li key={index} data-status={step.status} aria-current={running && step.status === "inProgress" ? "step" : undefined}>
        <span className="agent-plan-state">{labels[step.status]}</span><span>{step.step}</span>
      </li>)}
    </ol>
    {!running && count < plan.plan.length && <p>步骤尚未全部完成；回合结束不会自动标记完成。</p>}
    <small className="agent-plan-note">助手报告的进度，不是审批或成果验收。</small>
  </details>;
}
