import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ProjectStore } from "./store.ts";
import type { ExportJob } from "./export-formats.ts";

const python = process.env.SPRITE_STUDIO_PYTHON || "python";

async function finished(
  store: ProjectStore,
  projectId: string,
  job: ExportJob,
) {
  for (let attempt = 0; attempt < 2400; attempt++) {
    const current = store.exports.job(projectId, job.id);
    if (current.status !== "running") return current;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("导出没有在测试时限内结束");
}

function zipEntries(store: ProjectStore, projectId: string, filename: string) {
  const checked = spawnSync(
    python,
    [
      "-c",
      "import json,sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(json.dumps(sorted(z.namelist())))",
      store.exports.file(projectId, filename),
    ],
    { windowsHide: true, encoding: "utf8" },
  );
  assert.equal(checked.status, 0, checked.stderr);
  return JSON.parse(checked.stdout) as string[];
}

function inspect(archive: string, webp: string, gif: string) {
  const script = [
    "import sys,zipfile,json,io",
    "from PIL import Image",
    "z=zipfile.ZipFile(sys.argv[1])",
    "def info(name):",
    "    image=Image.open(io.BytesIO(z.read(name)))",
    "    return {'frames': getattr(image,'n_frames',1), 'size': list(image.size), 'loop': image.info.get('loop')}",
    "manifest=json.loads(z.read('export.json'))",
    "print(json.dumps({'webp': info(sys.argv[2]), 'gif': info(sys.argv[3]), 'clip': manifest['clips'][0]}))",
  ].join("\n");
  const decoded = spawnSync(python, ["-c", script, archive, webp, gif], {
    windowsHide: true,
    encoding: "utf8",
  });
  assert.equal(decoded.status, 0, decoded.stderr);
  return JSON.parse(decoded.stdout);
}

test("one-click export packs frames, atlas, WebP, GIF and the project archive", async () => {
  const root = mkdtempSync(join(tmpdir(), "sprite-studio-export-"));
  const fixture = join(root, "sheet.png");
  const generated = spawnSync(
    python,
    [
      "-c",
      "from PIL import Image,ImageDraw; import sys; im=Image.new('RGBA',(64,32)); d=ImageDraw.Draw(im); d.rectangle((0,0,31,31),fill='red'); d.rectangle((32,0,63,31),fill='blue'); im.save(sys.argv[1])",
      fixture,
    ],
    { windowsHide: true },
  );
  assert.equal(generated.status, 0, generated.stderr.toString());
  const store = new ProjectStore(join(root, "projects"));
  const project = store.createProject("导出验证");
  try {
    const source = await store.importImage(
      project.id,
      "sheet.png",
      readFileSync(fixture),
    );
    const clip = await store.slice(project.id, source.id, source.revision, {
      columns: 2,
      rows: 1,
      fps: 8,
    });
    assert.equal(clip.frames.length, 2);

    const job = store.exports.create(project.id, {
      format: "all",
      clipIds: [clip.id],
    });
    const done = await finished(store, project.id, job);
    assert.equal(done.status, "completed", done.error);
    assert.ok(done.filename?.endsWith(".zip"));
    const stem = clip.name;
    const archive = store.exports.file(project.id, done.filename!);
    const names = zipEntries(store, project.id, done.filename!);
    for (const expected of [
      "export.json",
      `frames/${stem}/${stem}_00.png`,
      `frames/${stem}/${stem}_01.png`,
      `atlas/${stem}.png`,
      `atlas/${stem}.json`,
      `webp/${stem}.webp`,
      `webp/${stem}.animation.json`,
      `gif/${stem}.gif`,
      `gif/${stem}.animation.json`,
    ])
      assert.ok(names.includes(expected), `${expected} missing from ${names}`);

    const preview = inspect(
      archive,
      `webp/${stem}.webp`,
      `gif/${stem}.gif`,
    );
    assert.equal(preview.webp.frames, 2);
    assert.deepEqual(preview.webp.size, [32, 32]);
    assert.equal(preview.webp.loop, 0);
    assert.equal(preview.gif.frames, 2);
    assert.equal(preview.gif.loop, 0);
    assert.equal(preview.clip.width, 32);
    assert.equal(preview.clip.count, 2);
    assert.equal(preview.clip.durationMs, 250);
    assert.deepEqual(
      store.exports.list(project.id).records.map((record) => record.filename),
      [done.filename],
    );

    const webpOnly = store.exports.create(project.id, { format: "webp" });
    const short = await finished(store, project.id, webpOnly);
    assert.equal(short.status, "completed", short.error);
    assert.deepEqual(zipEntries(store, project.id, short.filename!), [
      "export.json",
      `webp/${stem}.animation.json`,
      `webp/${stem}.webp`,
    ]);

    const archiveJob = store.exports.create(project.id, { format: "project" });
    const archived = await finished(store, project.id, archiveJob);
    assert.equal(archived.status, "completed", archived.error);
    const archiveNames = zipEntries(store, project.id, archived.filename!);
    assert.ok(archiveNames.includes("export.json"));
    assert.ok(archiveNames.includes("project.json"));
    assert.ok(
      archiveNames.some(
        (name) =>
          name.startsWith("Assets/动画/") &&
          name.endsWith(`${stem}.clip.json`),
      ),
      archiveNames.join("\n"),
    );
    assert.ok(
      archiveNames.some(
        (name) => name.startsWith("Assets/原图素材/") && name.endsWith(".png"),
      ),
    );
    assert.ok(archiveNames.some((name) => name.endsWith(".meta.json")));
    assert.equal(store.exports.list(project.id).records.length, 3);
  } finally {
    store.worker.close();
  }
});

test("review export renders the expanded sequence with repeat and speed", async () => {
  const root = mkdtempSync(join(tmpdir(), "sprite-studio-export-review-"));
  const fixture = join(root, "sheet.png");
  const generated = spawnSync(
    python,
    [
      "-c",
      "from PIL import Image,ImageDraw; import sys; im=Image.new('RGBA',(64,32)); d=ImageDraw.Draw(im); d.rectangle((0,0,31,31),fill='red'); d.rectangle((32,0,63,31),fill='blue'); im.save(sys.argv[1])",
      fixture,
    ],
    { windowsHide: true },
  );
  assert.equal(generated.status, 0, generated.stderr.toString());
  const store = new ProjectStore(join(root, "projects"));
  const project = store.createProject("Review导出");
  try {
    const source = await store.importImage(
      project.id,
      "sheet.png",
      readFileSync(fixture),
    );
    const clip = await store.slice(project.id, source.id, source.revision, {
      columns: 2,
      rows: 1,
      fps: 8,
    });
    const definition = store.reviewSequences.create(project.id, {
      requestId: randomUUID(),
      name: "待机序列",
      loop: true,
      segments: [{ id: randomUUID(), clipId: clip.id, repeat: 2, speed: 2 }],
    });
    const job = store.exports.create(project.id, {
      format: "review",
      reviewSequenceId: definition.id,
    });
    const done = await finished(store, project.id, job);
    assert.equal(done.status, "completed", done.error);
    const archive = store.exports.file(project.id, done.filename!);
    assert.deepEqual(zipEntries(store, project.id, done.filename!), [
      "export.json",
      "review/待机序列.animation.json",
      "review/待机序列.gif",
      "review/待机序列.webp",
    ]);
    const preview = inspect(
      archive,
      "review/待机序列.webp",
      "review/待机序列.gif",
    );
    assert.equal(preview.gif.frames, 4);
    assert.ok(preview.webp.frames >= 2);
    assert.equal(preview.clip.count, 4);
    assert.equal(preview.clip.reviewSequenceId, definition.id);
    assert.equal(preview.clip.name, "待机序列");
  } finally {
    store.worker.close();
  }
});

test("export validates format-specific requirements before starting work", () => {
  const root = mkdtempSync(join(tmpdir(), "sprite-studio-export-"));
  const store = new ProjectStore(join(root, "projects"));
  const project = store.createProject("导出拒绝");
  try {
    assert.throws(
      () => store.exports.create(project.id, { format: "frames" }),
      /还没有动画/,
    );
    assert.throws(
      () => store.exports.create(project.id, { format: "review" }),
      /Review/,
    );
    assert.throws(
      () => store.exports.create(project.id, { format: "unknown" }),
      /invalid|Invalid|option/i,
    );
    assert.deepEqual(store.exports.list(project.id), {
      records: [],
      jobs: [],
    });
  } finally {
    store.worker.close();
  }
});
