import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
export class ImagingWorker {
  root: string;
  child?: ReturnType<typeof spawn>;
  pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  id = 0;
  queue: Promise<unknown> = Promise.resolve();
  constructor(root: string) {
    this.root = root;
  }
  private start() {
    if (this.child && !this.child.killed && this.child.exitCode === null)
      return;
    const child = spawn(
      process.env.SPRITE_STUDIO_PYTHON || "python",
      [
        "-u",
        fileURLToPath(new URL("./imaging.py", import.meta.url)),
        this.root,
      ],
      { windowsHide: true, stdio: "pipe" },
    );
    this.child = child;
    let diagnostics = "";
    child.stderr?.on("data", (chunk) => {
      diagnostics = (diagnostics + chunk.toString()).slice(-1000);
    });
    const fail = (error: Error) => {
      if (this.child !== child) return;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(error);
      }
      this.pending.clear();
      this.child = undefined;
    };
    child.on("error", (error) =>
      fail(new Error(`无法启动图像处理：${error.message}`)),
    );
    child.on("exit", () =>
      fail(
        new Error(
          diagnostics.includes("No module named")
            ? "图像处理依赖缺失，请在 Python 环境中安装 Pillow"
            : "图像处理进程已退出，请重试",
        ),
      ),
    );
    createInterface({ input: child.stdout! }).on("line", (line) => {
      try {
        const response = JSON.parse(line);
        const p = this.pending.get(response.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(response.id);
        response.error
          ? p.reject(new Error(response.error))
          : p.resolve(response.result);
      } catch {
        if (child.pid && child.exitCode === null) {
          if (process.platform === "win32")
            spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
              windowsHide: true,
              stdio: "ignore",
            });
          else child.kill();
        }
        fail(new Error("图像处理返回了无效响应"));
      }
    });
  }
  run(
    method: string,
    params: Record<string, unknown>,
    options: { timeoutMs?: number } = {},
  ): Promise<any> {
    const task = this.queue
      .catch(() => {})
      .then(
        () =>
          new Promise((resolve, reject) => {
            this.start();
            const id = ++this.id;
            const timer = setTimeout(() => {
              this.close();
              reject(new Error("图像处理超时"));
            }, options.timeoutMs ?? 45_000);
            this.pending.set(id, { resolve, reject, timer });
            this.child!.stdin!.write(
              JSON.stringify({ id, method, params }) + "\n",
            );
          }),
      );
    this.queue = task;
    return task;
  }
  close() {
    const child = this.child;
    this.child = undefined;
    if (child?.pid && child.exitCode === null) {
      if (process.platform === "win32")
        spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      else child.kill();
    }
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("图像处理已停止"));
    }
    this.pending.clear();
  }
}
