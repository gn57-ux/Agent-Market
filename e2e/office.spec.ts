import {
  test,
  expect,
  type Page,
  type Frame,
  type FrameLocator,
  type Locator,
} from "@playwright/test";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  createPublicClient,
  createWalletClient,
  http as viemHttp,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

/**
 * Feature 15 (T-1504, AC-1504) — real browser verification of the Cocos
 * personal office. Uses the product's own real `?mock=1` demo mode (an
 * already-shipped, first-class feature of `office-frame-url.ts`/
 * `office-client.ts` — not a test-only shortcut) so this suite exercises
 * the full real pipeline (React → iframe → real Cocos WebGL runtime → real
 * `postMessage` → real React Router navigation) without also standing up a
 * real Postgres/chain backend, which the office snapshot's own real-data
 * path already has separate real coverage for
 * (`apps/api/src/modules/office/{funds-reader,schema}.test.ts`, migrated
 * and passing as part of T-1500/T-1501).
 *
 * The navigation test below does NOT hardcode a hotspot's world coordinates
 * or label text. That was tried first and broke: the *committed, deployed*
 * Cocos build under `apps/web/public/office-cocos/` (what this suite, and a
 * real user's browser, actually loads) was found to be a stale export that
 * predates a room redesign already present in
 * `apps/office-cocos/assets/scripts/OfficeBootstrap.ts` — different world
 * bounds, different hotspot coordinates, English labels instead of the
 * current Chinese ones, no wall/maze collision system at all. A real N4
 * Codex review independently caught the same desync when this file first
 * hardcoded the *source's* coordinates (which the deployed build doesn't
 * have) and pointed out the fix used here: read the hotspot's real position
 * off the live running scene instead. `findTaskBoardHotspot` below locates
 * the one hotspot whose own real navigation-target function (called for
 * real, in-page, against the real loaded snapshot) resolves to a
 * `task-detail`/`task-market` kind — not by matching a title string, which
 * would silently break the moment the label text or language changes. This
 * makes the test correct against whichever build is actually deployed, old
 * or new, and against a relabeled hotspot, since it depends only on the
 * semantic navigation contract (`office-navigation.ts`'s
 * `OfficeNavigationTarget`), not on coordinates or copy.
 *
 * Two real, empirically-diagnosed gotchas fixed here (verified by
 * screenshotting actual player displacement, not assumed):
 *
 * 1. Cocos's own input system only processes keyboard events once its
 *    iframe's `document.hasFocus()` is genuinely true. Playwright's
 *    `frame.locator("canvas").click()` alone focuses the canvas *element*
 *    (`document.activeElement` becomes the canvas) but does not transfer
 *    real top-level browser focus into the iframe's browsing context —
 *    `document.hasFocus()` inside the frame stayed `false`, and Cocos
 *    silently ignored every key event. Clicking the *outer* `<iframe>`
 *    element first (before the inner canvas) is what actually moves
 *    browser-level focus into the frame; only then does `hasFocus()`
 *    become `true` and movement genuinely register.
 * 2. The canvas element itself becomes visible (and thus passes a naive
 *    `toBeVisible()` wait) while Cocos is still showing its "Created with
 *    Cocos" boot splash — well before the real office scene has rendered.
 *    Interacting during the splash produces no observable effect. This
 *    suite waits for a real, content-specific signal instead of a fixed
 *    delay: a `RoomShadow`-sized canvas region actually contains non-black
 *    pixels (the splash is solid black; the office room is not).
 */

const OFFICE_IFRAME_TITLE = "Agent Market 个人虚拟工作室";

function getOfficeFrame(page: Page): { iframeEl: Locator; frame: FrameLocator } {
  const iframeEl = page.locator(`iframe[title='${OFFICE_IFRAME_TITLE}']`);
  const frame = page.frameLocator(`iframe[title='${OFFICE_IFRAME_TITLE}']`);
  return { iframeEl, frame };
}

/** frameLocator() is a locator-scoping convenience (great for
 * .locator()/.click()) but has no .evaluate() of its own — reading real
 * scene-graph state (readPlayerWorldPosition below) needs the actual
 * `Frame` object, obtained via the iframe element's contentFrame(). Must be
 * called *after* the scene is confirmed loaded (not right after
 * `page.goto()`) — grabbing it too early can reference a transient
 * pre-navigation frame whose scene graph is empty. */
async function getRealFrame(iframeEl: Locator): Promise<Frame> {
  const handle = await iframeEl.elementHandle();
  const realFrame = await handle?.contentFrame();
  if (!realFrame) throw new Error("getRealFrame: iframe has no content frame");
  return realFrame;
}

async function waitForRealSceneRender(page: Page, canvas: Locator): Promise<void> {
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  // Poll real screenshots until the frame is no longer solid black (the
  // splash screen) — a genuine content check, not a guessed timeout.
  await expect
    .poll(
      async () => {
        const shot = await canvas.screenshot();
        // A PNG that's entirely one color compresses to a tiny buffer;
        // real room art (multiple colored rects/labels) does not.
        return shot.byteLength;
      },
      { timeout: 20_000, intervals: [250, 250, 500, 500, 1000] },
    )
    .toBeGreaterThan(2_000);
  void page;
}

/** The one real fix for Cocos's input system silently ignoring keyboard
 * events (see file header, gotcha 1): focus the outer `<iframe>` element
 * itself before the canvas within it. */
async function focusOfficeFrame(iframeEl: Locator, canvas: Locator): Promise<void> {
  await iframeEl.click();
  await canvas.click();
}

async function holdMovementKeys(page: Page, seconds: number): Promise<void> {
  // Direction doesn't matter for this helper's one caller (the "movement
  // visibly displaces the player" test just needs *some* real
  // displacement) — D+S confirmed against OfficeBootstrap.ts's update()
  // horizontal/vertical key-to-axis mapping.
  await page.keyboard.down("KeyD");
  await page.keyboard.down("KeyS");
  await page.waitForTimeout(seconds * 1000);
  await page.keyboard.up("KeyD");
  await page.keyboard.up("KeyS");
}

async function findPlayerPosition(frame: Frame): Promise<{ x: number; y: number } | null> {
  return frame.evaluate(() => {
    const cc = (window as unknown as { cc?: { director?: { getScene?: () => unknown } } }).cc;
    const scene = cc?.director?.getScene?.() as
      { getChildByName?: (name: string) => unknown } | undefined;
    const canvasNode = scene?.getChildByName?.("Canvas") as
      { getChildByName?: (name: string) => unknown } | undefined;
    const player = canvasNode?.getChildByName?.("Player") as
      { position: { x: number; y: number } } | undefined;
    return player ? { x: player.position.x, y: player.position.y } : null;
  });
}

/** Real player world position, read directly off Cocos's own scene graph
 * (`window.cc`, which the engine exposes globally in this build) rather
 * than inferred from screen pixels — the camera re-centers on the player,
 * so screen position alone can't tell "near center" apart from "near
 * center after having walked 1000 real world units." This is ground
 * truth, not a guess.
 *
 * Polls rather than reading once: empirically, the `Player` node attaches
 * to the scene graph a real ~2s *after* the canvas already shows non-black
 * pixels (`waitForRealSceneRender`'s own readiness signal) — the room
 * background renders before the player prefab finishes building. Reading
 * too early throws "Player node not found" even though the scene is
 * visibly on-screen. */
async function readPlayerWorldPosition(frame: Frame): Promise<{ x: number; y: number }> {
  const deadline = Date.now() + 15_000;
  let position: { x: number; y: number } | null = null;
  while (Date.now() < deadline) {
    position = await findPlayerPosition(frame);
    if (position) return position;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    "readPlayerWorldPosition: Player node never appeared in the real scene graph within 15s",
  );
}

interface TaskBoardHotspot {
  readonly x: number;
  readonly y: number;
  readonly kind: "task-detail" | "task-market";
  readonly taskId: string | null;
}

async function findTaskBoardHotspotOnce(frame: Frame): Promise<TaskBoardHotspot | null> {
  return frame.evaluate(() => {
    interface SceneNode {
      name?: string;
      position?: { x: number; y: number };
      children?: SceneNode[];
      getComponent?: (name: string) => unknown;
    }
    const cc = (window as unknown as { cc?: { director?: { getScene?: () => SceneNode } } }).cc;
    function findNode(node: SceneNode | null | undefined, name: string): SceneNode | null {
      if (!node) return null;
      if (node.name === name) return node;
      for (const child of node.children ?? []) {
        const found = findNode(child, name);
        if (found) return found;
      }
      return null;
    }
    const scene = cc?.director?.getScene?.();
    const bootstrapNode = findNode(scene, "OfficeBootstrap");
    interface Hotspot {
      node: { position: { x: number; y: number } };
      target: (snapshot: unknown) => { kind: string; taskId?: string };
    }
    const comp = bootstrapNode?.getComponent?.("OfficeBootstrap") as
      { hotspots?: Hotspot[]; snapshot?: unknown } | undefined;
    if (!comp?.hotspots || !comp.snapshot) return null;
    for (const hotspot of comp.hotspots) {
      const navTarget = hotspot.target(comp.snapshot);
      if (navTarget.kind === "task-detail" || navTarget.kind === "task-market") {
        return {
          x: hotspot.node.position.x,
          y: hotspot.node.position.y,
          kind: navTarget.kind,
          taskId: navTarget.taskId ?? null,
        };
      }
    }
    return null;
  });
}

/** Finds the hotspot that navigates to a task — identified by its real,
 * live `target(snapshot)` navigation result (`task-detail`/`task-market`),
 * never by title text or hardcoded coordinates (see file header for why).
 * Polls because `comp.snapshot` populates asynchronously after
 * `loadOfficeSnapshot` resolves, same real timing gap documented on
 * `readPlayerWorldPosition`. */
async function findTaskBoardHotspot(frame: Frame): Promise<TaskBoardHotspot> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const hotspot = await findTaskBoardHotspotOnce(frame);
    if (hotspot) return hotspot;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    "findTaskBoardHotspot: no task-navigating hotspot found in the real scene within 15s",
  );
}

interface AnyHotspot {
  readonly x: number;
  readonly y: number;
  readonly title: string;
  readonly kind: string;
  readonly taskId: string | null;
  readonly agentId: string | null;
}

/** Same real-scene-graph technique as `findTaskBoardHotspotOnce`
 * (`comp.hotspots`, each hotspot's own real `target(snapshot)` called
 * in-page), generalized to return every hotspot instead of filtering to
 * one kind — used by the AC-1504 N6-follow-up coverage below (T-1504b) for
 * the other 5 hotspots. Not merged into `findTaskBoardHotspotOnce` itself
 * to avoid touching that already-reviewed, already-passing function. */
async function getAllHotspotsOnce(frame: Frame): Promise<AnyHotspot[] | null> {
  return frame.evaluate(() => {
    interface SceneNode {
      name?: string;
      position?: { x: number; y: number };
      children?: SceneNode[];
      getComponent?: (name: string) => unknown;
    }
    const cc = (window as unknown as { cc?: { director?: { getScene?: () => SceneNode } } }).cc;
    function findNode(node: SceneNode | null | undefined, name: string): SceneNode | null {
      if (!node) return null;
      if (node.name === name) return node;
      for (const child of node.children ?? []) {
        const found = findNode(child, name);
        if (found) return found;
      }
      return null;
    }
    const scene = cc?.director?.getScene?.();
    const bootstrapNode = findNode(scene, "OfficeBootstrap");
    interface Hotspot {
      node: { position: { x: number; y: number } };
      title: string;
      target: (snapshot: unknown) => { kind: string; taskId?: string; agentId?: string };
    }
    const comp = bootstrapNode?.getComponent?.("OfficeBootstrap") as
      { hotspots?: Hotspot[]; snapshot?: unknown } | undefined;
    if (!comp?.hotspots || !comp.snapshot) return null;
    return comp.hotspots.map((hotspot) => {
      const navTarget = hotspot.target(comp.snapshot);
      return {
        x: hotspot.node.position.x,
        y: hotspot.node.position.y,
        title: hotspot.title,
        kind: navTarget.kind,
        taskId: navTarget.taskId ?? null,
        agentId: navTarget.agentId ?? null,
      };
    });
  });
}

async function getAllHotspots(frame: Frame): Promise<AnyHotspot[]> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const hotspots = await getAllHotspotsOnce(frame);
    if (hotspots) return hotspots;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("getAllHotspots: hotspots never populated in the real scene within 15s");
}

/** Real corridor waypoints for reaching a wing room (Agent 工位/托管资金区/
 * 交付工作台/Web 导航) from spawn (0,0). Straight-line movement cannot reach
 * these four hotspots (see file header on the maze) — read directly off
 * `apps/office-cocos/assets/scripts/OfficeBootstrap.ts`'s `buildRoomWalls`/
 * `buildWingWalls`: the plaza's west/east exits and the corridor↔spine
 * boundary are only open for y (or x, on the cross-corridor) within
 * roughly (-110,110) around the center line, and each wing room's only
 * entrance is a door gap at x=∓1200 open for y within about
 * (540,760)/( -760,-540) around the room's own y. This walks the real,
 * verified-clear route through that structure rather than attempting a
 * generic pathfinder over a hand-authored maze that only has six fixed
 * destinations. Waypoint y-values are the hotspot's own REAL y (read live,
 * not hardcoded), so this stays correct even if a hotspot's height in its
 * room ever changes. */
function wingWaypoints(hotspot: { x: number; y: number }): { x: number; y: number }[] {
  const side = hotspot.x < 0 ? -1 : 1;
  return [
    { x: side * 700, y: 0 },
    { x: side * 1050, y: 0 },
    { x: side * 1050, y: hotspot.y },
    { x: side * 1300, y: hotspot.y },
    { x: hotspot.x, y: hotspot.y },
  ];
}

/** Moves in short, verified bursts toward `target` until the real player
 * position (ground truth, see `readPlayerWorldPosition`) is within
 * `radius` of it, or `maxAttempts` bursts have elapsed. Empirically
 * calibrated rather than guessed: a fixed-duration hold turned out
 * unreliable because this headless environment's effective movement speed
 * (~29 world-units/real-second, read directly off the scene graph) is far
 * below the naive SPEED=260-units/sec/no-throttling assumption — measuring
 * real position after each burst and correcting course removes that
 * guesswork entirely, and is what actually makes this deterministic. */
async function walkToward(
  page: Page,
  frame: Frame,
  target: { x: number; y: number },
  radius: number,
  maxAttempts = 40,
  burstMs = 2_000,
): Promise<{ x: number; y: number }> {
  // Below this per-axis offset, don't press that axis's key at all — a
  // ternary's implicit >=0 default (e.g. dx===0 on a due-north walk) would
  // otherwise still hold a horizontal key every burst and drift the player
  // sideways into a corridor wall instead of going straight.
  const AXIS_DEADBAND = 20;
  let position = await readPlayerWorldPosition(frame);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const distance = Math.hypot(target.x - position.x, target.y - position.y);
    if (distance < radius) return position;
    const dx = target.x - position.x;
    const dy = target.y - position.y;
    const horizontalKey = Math.abs(dx) > AXIS_DEADBAND ? (dx > 0 ? "KeyD" : "KeyA") : null;
    const verticalKey = Math.abs(dy) > AXIS_DEADBAND ? (dy > 0 ? "KeyW" : "KeyS") : null;
    if (horizontalKey) await page.keyboard.down(horizontalKey);
    if (verticalKey) await page.keyboard.down(verticalKey);
    await page.waitForTimeout(burstMs);
    if (horizontalKey) await page.keyboard.up(horizontalKey);
    if (verticalKey) await page.keyboard.up(verticalKey);
    position = await readPlayerWorldPosition(frame);
  }
  return position;
}

/** Walks through a sequence of waypoints (each `walkToward`'s own
 * verified-burst movement, back to back) — used for the 4 wing hotspots,
 * which straight-line movement cannot reach (see `wingWaypoints`'s own doc
 * comment on the real corridor/door structure). Returns the final real
 * position after the last waypoint; does not itself assert success on
 * intermediate legs — only the caller's own distance check against the
 * final waypoint matters for the test's pass/fail.
 *
 * Uses a much shorter burst (400ms, vs `walkToward`'s own 2s default) than
 * the single-target tests: empirically, this headless environment's real
 * per-burst displacement varies run to run (measured ~29 to ~260
 * units/real-second across different runs/legs), and a 2s burst can
 * overshoot a tight intermediate waypoint by hundreds of units — enough,
 * on the vertical leg into a wing room, to overshoot clean past the real
 * ~220-unit-tall door gap and wedge the player into a wall corner it can
 * no longer back out of. Shorter bursts shrink that overshoot
 * proportionally at the cost of more round trips, which is the right
 * trade for these tight corridor legs. */
async function walkPath(
  page: Page,
  frame: Frame,
  waypoints: { x: number; y: number }[],
  finalRadius: number,
): Promise<{ x: number; y: number }> {
  let position = { x: 0, y: 0 };
  for (let index = 0; index < waypoints.length; index += 1) {
    const waypoint = waypoints[index];
    if (!waypoint) continue;
    const isFinal = index === waypoints.length - 1;
    // The final leg's target sits just outside the hotspot's own physical
    // collision box — real geometry (137×84 half-extents inside a 145
    // interaction radius) leaves only a narrow reachable band along an
    // axis-aligned approach, so it gets a much finer burst (150ms, more
    // attempts) than the open-corridor legs to reliably land inside it.
    position = isFinal
      ? await walkToward(page, frame, waypoint, finalRadius, 150, 150)
      : await walkToward(page, frame, waypoint, 100, 60, 400);
  }
  return position;
}

test.describe("Feature 15 — Cocos personal office (real browser, ?mock=1)", () => {
  test("iframe loads a real Cocos canvas past the boot splash, and WASD movement genuinely displaces the player", async ({
    page,
  }) => {
    await page.goto("/office?mock=1");
    const { iframeEl, frame } = getOfficeFrame(page);
    const canvas = frame.locator("canvas").first();
    await waitForRealSceneRender(page, canvas);
    await focusOfficeFrame(iframeEl, canvas);
    // Captured only now (scene confirmed loaded) — see getRealFrame's own
    // doc comment for why grabbing this too early is unreliable.
    const realFrame = await getRealFrame(iframeEl);

    // A before/after canvas-screenshot diff (tried first) is not sound
    // evidence here: the Player node itself attaches to the scene graph a
    // real ~2s after the canvas already shows non-black pixels (see
    // readPlayerWorldPosition's own doc comment), so that asynchronous
    // appearance alone would flip screenshot bytes even if WASD input were
    // completely broken and the player never actually moved — a real N4
    // Codex review caught exactly this gap. Reading real scene-graph
    // position before and after (ground truth, not screen pixels) is what
    // actually proves the keypresses displaced the player.
    const before = await readPlayerWorldPosition(realFrame);
    await holdMovementKeys(page, 3);
    const after = await readPlayerWorldPosition(realFrame);

    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(0);
  });

  test("walking to the real task-navigating hotspot and pressing Enter sends a real postMessage that really navigates the parent to the fixture's published task", async ({
    page,
  }) => {
    test.setTimeout(150_000); // walkToward's verified bursts can take longer than the 45s default
    await page.goto("/office?mock=1");
    const { iframeEl, frame } = getOfficeFrame(page);
    const canvas = frame.locator("canvas").first();
    await waitForRealSceneRender(page, canvas);
    await focusOfficeFrame(iframeEl, canvas);
    // Captured only now (scene confirmed loaded) — see getRealFrame's own
    // doc comment for why grabbing this too early is unreliable.
    const realFrame = await getRealFrame(iframeEl);

    // Real position of the real task-navigating hotspot, read off the live
    // scene (see findTaskBoardHotspot's own doc comment, and the file
    // header, for why this isn't a hardcoded coordinate). Walk in verified
    // bursts (see walkToward's own doc comment for why a fixed-duration
    // hold isn't reliable here) until within a generous radius of it — 100
    // is comfortably inside every interaction radius this office has used
    // (145 in both the currently-deployed build and current source).
    const hotspot = await findTaskBoardHotspot(realFrame);
    const finalPosition = await walkToward(page, realFrame, { x: hotspot.x, y: hotspot.y }, 100);
    const distance = Math.hypot(hotspot.x - finalPosition.x, hotspot.y - finalPosition.y);
    expect(distance).toBeLessThan(100);

    // Re-focus (movement bursts can lose canvas focus) before the real
    // interact key.
    await focusOfficeFrame(iframeEl, canvas);
    await page.keyboard.press("Enter");

    // Expected path mirrors office-navigation.ts's officeTargetPath mapping
    // for the real navigation-target kind we resolved the hotspot by, not a
    // hardcoded route — task-market has no taskId (falls back to the task
    // market listing) while task-detail carries the fixture's real
    // published[0].taskId.
    const expectedPath = hotspot.kind === "task-detail" ? `/tasks/${hotspot.taskId}` : "/tasks";
    await expect(page).toHaveURL(new RegExp(`${expectedPath}$`), { timeout: 5_000 });
  });

  test("iframe URL correctly forwards the outer page's own ?mock=1 into the embedded app (F-1503's query allow-list)", async ({
    page,
  }) => {
    await page.goto("/office?mock=1");
    const iframeSrc = await page
      .locator(`iframe[title='${OFFICE_IFRAME_TITLE}']`)
      .getAttribute("src");
    expect(iframeSrc).toContain("mock=1");
    // An unrelated outer query param must never leak into the iframe URL
    // (office-frame-url.ts's own documented allow-list contract).
    await page.goto("/office?mock=1&evil=should-not-leak");
    const iframeSrc2 = await page
      .locator(`iframe[title='${OFFICE_IFRAME_TITLE}']`)
      .getAttribute("src");
    expect(iframeSrc2).not.toContain("evil");
  });

  // AC-1504 (T-1504b, N6 follow-up): the previous test above only proves
  // ONE of the 6 hotspots (whichever resolves to task-detail/task-market)
  // triggers a real postMessage + real navigation. AC-1504's own text
  // requires all 6. This test walks to each of the other 5 in turn (a
  // fresh `page.goto` per hotspot, so the player always starts back at
  // spawn) and verifies each one's OWN real target()/postMessage/final
  // route — not just that the shared addHotspot/updateInteraction/
  // requestParentNavigation machinery fired once for some hotspot.
  test("walking to each of the other 5 hotspots and pressing Enter sends each one's own real postMessage target and route", async ({
    page,
  }) => {
    test.setTimeout(300_000);
    await page.goto("/office?mock=1");
    const { iframeEl: firstIframeEl, frame: firstFrame } = getOfficeFrame(page);
    await waitForRealSceneRender(page, firstFrame.locator("canvas").first());
    const realFrame = await getRealFrame(firstIframeEl);
    const allHotspots = await getAllHotspots(realFrame);
    // The hotspot already covered by the test above — matched by real
    // position, the same technique `findTaskBoardHotspot` itself uses to
    // pick it (first hotspot whose real target() resolves to
    // task-detail/task-market). NOT filtered by kind: this suite's real
    // `?mock=1` fixture also gives 交付工作台 (deliveryDesk[0]) its own
    // task-detail target with a DIFFERENT taskId, so excluding by kind
    // would wrongly skip a real, distinct hotspot instead of just the one
    // already-tested instance.
    const alreadyCovered = await findTaskBoardHotspot(realFrame);
    const remaining = allHotspots.filter(
      (hotspot) => hotspot.x !== alreadyCovered.x || hotspot.y !== alreadyCovered.y,
    );
    expect(remaining.length).toBe(5);

    function expectedPathFor(hotspot: AnyHotspot): string {
      switch (hotspot.kind) {
        case "agent-detail":
          return `/agents/${hotspot.agentId}`;
        case "agent-market":
          return "/agents";
        case "task-detail":
          return `/tasks/${hotspot.taskId}`;
        case "task-market":
          return "/tasks";
        case "my-workbench":
          return "/tasks/accepted";
        case "web-home":
          return "/";
        default:
          throw new Error(`expectedPathFor: unexpected hotspot kind "${hotspot.kind}"`);
      }
    }

    for (const hotspot of remaining) {
      await test.step(`${hotspot.title} (${hotspot.kind})`, async () => {
        // Fresh navigation per hotspot — the player must start back at the
        // real spawn point (0,0) for `wingWaypoints`'s corridor route to be
        // valid; walking two hotspots back to back without resetting would
        // start from wherever the previous hotspot left the player.
        await page.goto("/office?mock=1");
        const { iframeEl, frame } = getOfficeFrame(page);
        const canvas = frame.locator("canvas").first();
        await waitForRealSceneRender(page, canvas);
        await focusOfficeFrame(iframeEl, canvas);
        const liveFrame = await getRealFrame(iframeEl);
        // Re-read this hotspot's own real live position/kind for this fresh
        // page load, rather than reusing the position captured on the
        // earlier page instance.
        const live = (await getAllHotspots(liveFrame)).find((h) => h.title === hotspot.title);
        if (!live) throw new Error(`hotspot "${hotspot.title}" not found on fresh page load`);

        const waypoints =
          Math.abs(live.x) < 500
            ? [{ x: live.x, y: live.y }] // north/south center hotspots: straight line
            : wingWaypoints(live);
        // 140, not the interaction radius's own 145: the hotspot's physical
        // collision box (isBlocked's 137×84 half-extents) keeps the player
        // at least ~137 units away in x when approaching along y≈hotspot.y
        // — a tighter test radius would be geometrically unreachable no
        // matter how the walk converges, not a real failure.
        const finalPosition = await walkPath(page, liveFrame, waypoints, 140);
        const distance = Math.hypot(live.x - finalPosition.x, live.y - finalPosition.y);
        expect(distance, `did not reach real interaction radius of "${live.title}"`).toBeLessThan(
          145,
        );

        await focusOfficeFrame(iframeEl, canvas);
        await page.keyboard.press("Enter");

        await expect(page).toHaveURL(new RegExp(`${expectedPathFor(live)}$`), { timeout: 5_000 });
      });
    }
  });

  // AC-1504 (T-1504b, N6 follow-up): OfficePage.tsx's own 12s fallback
  // (`frameState==="loading" → "failed"`) is keyed to the <iframe>'s own
  // `onLoad`/`onError` DOM events, not to whether the embedded app's own
  // `/office/snapshot` fetch succeeds — a slow/failed snapshot fetch is
  // handled entirely INSIDE the Cocos app (`setDetail("工作室数据暂不可用…")`,
  // already covered by the RPC-unavailable scenario elsewhere), not by this
  // React-level panel. To make the iframe document itself never finish
  // loading — the only real condition this panel exists for — this
  // intercepts its network request and never resolves it (a standard,
  // real technique for testing a genuinely-hung load, not a mock of
  // React's own logic). The 12s wait itself is real production behavior
  // exercised through Playwright's clock (`page.clock`), which advances
  // the SAME `window.setTimeout` OfficePage.tsx actually calls — this is
  // not a shortcut around the component's real timer, it only removes the
  // need to burn 12 real wall-clock seconds waiting for it.
  test("the iframe's own 12-second load timeout shows the real degrade panel when the iframe document never finishes loading", async ({
    page,
  }) => {
    await page.clock.install();
    await page.route("**/office-cocos/index.html**", async () => {
      // Never call route.fulfill/continue/abort — the request stays
      // pending forever, so the <iframe> never fires load or error.
      await new Promise(() => {});
    });

    await page.goto("/office");

    await expect(page.getByText("正在加载工作室…")).toBeVisible();
    await expect(page.getByRole("alert", { name: "虚拟工作室暂时无法加载" })).toHaveCount(0);

    await page.clock.fastForward(12_000);

    await expect(page.getByRole("alert")).toContainText("虚拟工作室暂时无法加载");
    await expect(page.getByRole("link", { name: "进入普通工作台" })).toBeVisible();
  });
});

/**
 * AC-1504 (T-1504b, N6 follow-up) — the funds-zone scenarios the `?mock=1`
 * suite above cannot exercise: it always renders a fixture snapshot
 * client-side, never a real `GET /office/snapshot` round trip. This
 * describe block stands up a REAL local Hardhat node, REAL deployed
 * `YDToken`/`TaskEscrow` contracts, a REAL Postgres-backed `apps/api`
 * server (the actual `src/server.ts` entrypoint via `tsx`, not a
 * hand-rolled substitute), and drives the SAME real Cocos scene the
 * `?mock=1` suite does — but in its real (non-mock) mode — to prove the
 * "托管资金区" hotspot's rendered text genuinely reflects a live
 * `officeFundsReader` read, both when the RPC is reachable and when it
 * isn't, with a real recovery in between.
 *
 * Gated behind the same two env vars this repo's other real-Hardhat e2e
 * suites already use (`RUN_DB_INTEGRATION_TESTS=1` +
 * `RUN_HARDHAT_E2E_TESTS=1`) — design.md's own instruction not to invent a
 * third gate. `apps/web`'s already-built `dist/` (served by the `vite
 * preview` this whole file's `webServer`/manual-start setup already
 * requires) needs no rebuild: `apiBaseUrl()`'s own default
 * (`http://localhost:3001`) already matches the fixed port this describe
 * block starts its real API server on.
 *
 * Isolation (explicit user requirement): every port this block binds is
 * checked free immediately beforehand and refuses to proceed if occupied
 * (never silently steals a port a real `local-env` manifest might be
 * using); every spawned process (hardhat node, each api-server respawn) is
 * killed in `afterAll`; the only Postgres rows this block writes are
 * deleted by their own known keys in `afterAll`, never a table-wide DROP
 * (which would race destructively against any other suite sharing this
 * same `TEST_DATABASE_URL`).
 */
const runRealBackendTests =
  process.env.RUN_DB_INTEGRATION_TESTS === "1" && process.env.RUN_HARDHAT_E2E_TESTS === "1"
    ? test.describe
    : test.describe.skip;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACTS_DIR = path.join(REPO_ROOT, "contracts");
const API_DIR = path.join(REPO_ROOT, "apps/api");
const MIGRATIONS_DIR = path.join(API_DIR, "migrations");
const WEB_DIR = path.join(REPO_ROOT, "apps/web");
// A dedicated build output — never `dist` (the shared build this file's
// `?mock=1` suite's own already-running `vite preview` instance on 4173
// serves; building over it mid-suite would be a real, disruptive race).
// Deleted in this describe block's own afterAll — never left behind.
const WEB_E2E_DIST_DIR = path.join(WEB_DIR, ".office-real-backend-e2e-dist");

// Same well-known deterministic Hardhat Network default accounts this
// repo's other hardhat e2e suites already use (apps/api/src/e2e/*) —
// publicly documented, hold no real value.
const HARDHAT_ACCOUNT_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
] as const;

function readArtifact(relativePath: string): { abi: unknown; bytecode: Hex } {
  const raw = readFileSync(path.join(CONTRACTS_DIR, relativePath), "utf8");
  const parsed = JSON.parse(raw) as { abi: unknown; bytecode: string };
  return { abi: parsed.abi, bytecode: parsed.bytecode as Hex };
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const { port } = address;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error("getFreePort: failed to acquire a free TCP port"));
      }
    });
  });
}

async function waitForHttpReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `waitForHttpReady: ${url} never became ready within ${timeoutMs}ms` +
      (lastError ? ` (last error: ${String(lastError)})` : ""),
  );
}

async function waitForRpcReady(rpcUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `waitForRpcReady: hardhat node at ${rpcUrl} never became ready within ${timeoutMs}ms` +
      (lastError ? ` (last error: ${String(lastError)})` : ""),
  );
}

type ApiProcess = ChildProcessByStdio<null, Readable, Readable>;

/** Spawns the REAL `apps/api` production entrypoint (`src/server.ts` via
 * `tsx`, not a hand-rolled `buildApp()+listen()` substitute) with an
 * explicit, fully-overridden environment — never inheriting this test
 * runner's own `process.env`, so nothing here can accidentally point at a
 * real developer's real `.env` configuration. `ACCEPTANCE_PERMIT_SIGNER_KEY`
 * is set to the same private key used as the deployed `TaskEscrow`'s
 * `authorizedSigner` — required for `server.ts`'s own real startup gate
 * (`verifyStartupSignerConfig`) to pass; this describe block doesn't touch
 * acceptance permits otherwise, but can't skip the check server.ts itself
 * always runs. */
function startApiServer(env: Record<string, string>): {
  process: ApiProcess;
  stderr: () => string;
} {
  const child = spawn(path.join(API_DIR, "node_modules/.bin/tsx"), ["src/server.ts"], {
    cwd: API_DIR,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  }) as ApiProcess;
  // pino (this app's real logger) writes to stdout by default, not
  // stderr — captured here too so a real startup failure is never lost.
  let output = "";
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString();
  });
  return { process: child, stderr: () => output };
}

async function killApiServer(handle: { process: ApiProcess } | undefined): Promise<void> {
  if (!handle) return;
  handle.process.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
}

runRealBackendTests(
  "Feature 15 — Cocos personal office funds zone (real Hardhat + real API + real Postgres + real browser)",
  () => {
    let pool: Pool;
    let hardhatProcess: ChildProcessByStdio<null, Readable, Readable>;
    let hardhatStderr = "";
    let rpcUrl: string;
    let chainId: number;
    let ydTokenAddress: `0x${string}`;
    let escrowAddress: `0x${string}`;
    let apiHandle: { process: ApiProcess; stderr: () => string } | undefined;
    let sessionToken: string;
    // Allocated once and never reassigned — a real, pre-existing,
    // long-running unrelated `apps/api` process was found squatting on
    // this app's usual default port (3001) during development of this
    // suite, which is why this never assumes or targets a fixed port, only
    // a freshly verified-free one. The api SERVER itself is started only
    // ONCE for this whole describe block (see `restartHardhat`'s own doc
    // comment for why the RPC-outage/recovery cycle below restarts the
    // underlying Hardhat node instead of the api server).
    let apiPort: number;
    let hardhatPort: number;
    let webPreviewPort: number;
    let webPreviewHandle: ChildProcessByStdio<null, Readable, Readable> | undefined;

    const viewer = privateKeyToAccount(generatePrivateKey());
    // viem's PrivateKeyAccount does not re-expose the raw key as a
    // `.privateKey` property (by design) — the real key string this
    // suite needs for ACCEPTANCE_PERMIT_SIGNER_KEY is kept here directly,
    // not read back off the derived Account object.
    const authorizedSignerKey = HARDHAT_ACCOUNT_KEYS[2];
    const authorizedSigner = privateKeyToAccount(authorizedSignerKey);
    const arbitrator = privateKeyToAccount(HARDHAT_ACCOUNT_KEYS[3]);
    const deployer = privateKeyToAccount(HARDHAT_ACCOUNT_KEYS[0]);

    async function spawnHardhatOn(port: number): Promise<void> {
      hardhatStderr = "";
      hardhatProcess = spawn(
        path.join(CONTRACTS_DIR, "node_modules/.bin/hardhat"),
        ["node", "--port", String(port), "--hostname", "127.0.0.1"],
        { cwd: CONTRACTS_DIR, stdio: ["ignore", "pipe", "pipe"] },
      );
      hardhatProcess.stderr.on("data", (chunk: Buffer) => {
        hardhatStderr += chunk.toString();
      });
      const spawnErrorPromise = new Promise<never>((_resolve, reject) => {
        hardhatProcess.once("error", reject);
      });
      try {
        await Promise.race([waitForRpcReady(rpcUrl, 30_000), spawnErrorPromise]);
      } catch (error) {
        throw new Error(`${String(error)}\nhardhat node stderr:\n${hardhatStderr}`);
      }
    }

    /** Deploys YDToken (initial supply straight to `viewer` — see its own
     * inline comment) then TaskEscrow, from the SAME deployer account in
     * the SAME order every time this is called. Hardhat's CREATE address
     * is `keccak256(rlp(sender, nonce))`-deterministic, and a freshly
     * started `hardhat node` always resets EVERY account back to nonce 0
     * — so redeploying in this same order against a freshly (re)started
     * node reproduces the EXACT SAME two contract addresses as the
     * original deployment. This is what makes the real-recovery phase
     * below work without ever restarting or reconfiguring the already
     * running api server: its `YD_TOKEN_ADDRESS`/`TASK_ESCROW_ADDRESS` env
     * vars, fixed at its own single startup, stay valid across a Hardhat
     * node outage-and-restart. */
    async function deployContracts(): Promise<void> {
      const publicClient: PublicClient = createPublicClient({ transport: viemHttp(rpcUrl) });
      chainId = await publicClient.getChainId();
      const deployerWallet = createWalletClient({ account: deployer, transport: viemHttp(rpcUrl) });

      const ydTokenArtifact = readArtifact("artifacts/src/YDToken.sol/YDToken.json");
      const initialSupply = 10_000n * 10n ** 18n;
      const ydTokenDeployHash = await deployerWallet.deployContract({
        abi: ydTokenArtifact.abi as never,
        bytecode: ydTokenArtifact.bytecode,
        args: [viewer.address, initialSupply],
        chain: null,
      });
      const ydTokenReceipt = await publicClient.waitForTransactionReceipt({
        hash: ydTokenDeployHash,
      });
      if (!ydTokenReceipt.contractAddress)
        throw new Error("YDToken deployment produced no address");
      const newYdTokenAddress = ydTokenReceipt.contractAddress;

      const taskEscrowArtifact = readArtifact("artifacts/src/TaskEscrow.sol/TaskEscrow.json");
      const escrowDeployHash = await deployerWallet.deployContract({
        abi: taskEscrowArtifact.abi as never,
        bytecode: taskEscrowArtifact.bytecode,
        args: [newYdTokenAddress, authorizedSigner.address, 259_200n, arbitrator.address],
        chain: null,
      });
      const escrowReceipt = await publicClient.waitForTransactionReceipt({
        hash: escrowDeployHash,
      });
      if (!escrowReceipt.contractAddress)
        throw new Error("TaskEscrow deployment produced no address");
      const newEscrowAddress = escrowReceipt.contractAddress;

      if (ydTokenAddress !== undefined && ydTokenAddress !== newYdTokenAddress) {
        throw new Error(
          `deployContracts: redeploy produced a DIFFERENT YDToken address (${newYdTokenAddress} ` +
            `vs original ${ydTokenAddress}) — the deterministic-nonce assumption this suite's ` +
            "recovery phase depends on doesn't hold in this environment.",
        );
      }
      if (escrowAddress !== undefined && escrowAddress !== newEscrowAddress) {
        throw new Error(
          `deployContracts: redeploy produced a DIFFERENT TaskEscrow address (${newEscrowAddress} ` +
            `vs original ${escrowAddress}) — the deterministic-nonce assumption this suite's ` +
            "recovery phase depends on doesn't hold in this environment.",
        );
      }
      ydTokenAddress = newYdTokenAddress;
      escrowAddress = newEscrowAddress;
    }

    /** Kills the Hardhat node (if running) and, when `redeploy` is true,
     * respawns a fresh one on the SAME port and redeploys the same two
     * contracts to the same addresses (see `deployContracts`'s own doc
     * comment). `redeploy: false` is the RPC-outage phase itself — the
     * point is for the port to stay genuinely unreachable, not to bring
     * anything back up. */
    async function restartHardhat(redeploy: boolean): Promise<void> {
      hardhatProcess?.kill();
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (!redeploy) return;
      await spawnHardhatOn(hardhatPort);
      await deployContracts();
    }

    test.beforeAll(async () => {
      // Dynamic, not a top-level static import (N4 Codex finding, real
      // and correctly caught): `apps/api/dist` is gitignored build
      // output that does not exist on a clean checkout. A top-level
      // `import ... from "../apps/api/dist/..."` would fail module
      // resolution at Playwright's COLLECTION time — before either env
      // gate is even checked — breaking the default (ungated) `?mock=1`
      // suite on a clean checkout that has never run
      // `pnpm --filter @agent-market/api build`. This block only ever
      // executes once `runRealBackendTests` has already resolved to a
      // real (non-skip) `test.describe`, i.e. both env vars are set, so
      // deferring the import here (never reached otherwise) is what
      // actually keeps that precondition scoped to where it's needed.
      const { runMigrations } = await import("../apps/api/dist/db/migrate.js");
      const { requireTestDatabaseUrl } = await import("../apps/api/dist/db/test-support.js");

      apiPort = await getFreePort();
      webPreviewPort = await getFreePort();

      // `apps/web`'s already-built `dist/` (served on 4173 for the
      // `?mock=1` suite above) has `VITE_API_BASE_URL` baked in at build
      // time from the repo's real `.env` (found to be `localhost:3100`,
      // itself a real, unrelated, already-running `apps/api` process —
      // same story as `apiPort`'s own doc comment on port 3001).
      // Rewriting the embedded iframe's own `apiBaseUrl` query param at
      // request time (tried first) does not work: Chromium does not
      // treat a `route.continue({url})` redirect that only changes the
      // query string as a real navigation — the frame's own
      // `window.location.href` (confirmed by direct evaluation) still
      // reports the original, unrewritten URL, so `OfficeBootstrap.ts`
      // still reads the stale value. A real, separate build with the
      // correct `VITE_API_BASE_URL` is the only reliable way to point
      // the embedded app at this describe block's own dynamically
      // allocated api server.
      const buildResult = await new Promise<{ code: number | null; output: string }>((resolve) => {
        let output = "";
        const child = spawn(
          path.join(WEB_DIR, "node_modules/.bin/vite"),
          ["build", "--outDir", WEB_E2E_DIST_DIR],
          {
            cwd: WEB_DIR,
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              PATH: process.env.PATH ?? "",
              VITE_API_BASE_URL: `http://localhost:${apiPort}`,
            },
          },
        );
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.on("exit", (code) => resolve({ code, output }));
      });
      if (buildResult.code !== 0) {
        throw new Error(`apps/web build for real-backend e2e failed:\n${buildResult.output}`);
      }

      webPreviewHandle = spawn(
        path.join(WEB_DIR, "node_modules/.bin/vite"),
        [
          "preview",
          "--outDir",
          WEB_E2E_DIST_DIR,
          "--port",
          String(webPreviewPort),
          "--host",
          "127.0.0.1",
          "--strictPort",
        ],
        { cwd: WEB_DIR, stdio: ["ignore", "pipe", "pipe"] },
      );
      let webPreviewOutput = "";
      webPreviewHandle.stdout.on("data", (chunk: Buffer) => {
        webPreviewOutput += chunk.toString();
      });
      webPreviewHandle.stderr.on("data", (chunk: Buffer) => {
        webPreviewOutput += chunk.toString();
      });
      try {
        await waitForHttpReady(`http://127.0.0.1:${webPreviewPort}/`, 20_000);
      } catch (error) {
        throw new Error(`${String(error)}\nvite preview output:\n${webPreviewOutput}`);
      }

      pool = new Pool({ connectionString: requireTestDatabaseUrl() });
      await runMigrations(pool, MIGRATIONS_DIR);
      await pool.query(`INSERT INTO users (address) VALUES ($1) ON CONFLICT DO NOTHING`, [
        viewer.address.toLowerCase(),
      ]);
      // Real budget locked in a real published (OPEN) task — this is what
      // makes `funds.lockedBudget` genuinely non-zero, not just
      // `walletBalance` alone.
      await pool.query(
        `INSERT INTO tasks
           (requester_address, category, title, description, budget, token, delivery_deadline,
            status, expert_type)
         VALUES ($1, 'writing', 'Office funds-zone real-backend fixture', 'desc',
                 $2, $3, '2099-01-01T00:00:00Z', 'OPEN', 'AUTOMATION')`,
        [
          viewer.address.toLowerCase(),
          (2_000n * 10n ** 18n).toString(),
          "0x1111111111111111111111111111111111111111",
        ],
      );

      hardhatPort = await getFreePort();
      rpcUrl = `http://127.0.0.1:${hardhatPort}`;
      await spawnHardhatOn(hardhatPort);
      await deployContracts();

      // The api server is started exactly ONCE for this whole describe
      // block. `src/server.ts`'s own real startup gate
      // (`verifyStartupSignerConfig`) does a real chain read before
      // `app.listen()` ever runs — it cannot boot at all against an
      // unreachable RPC, so the RPC-outage scenario below must NOT try to
      // restart this process with a broken RPC URL (discovered the hard
      // way: an earlier version of this suite did exactly that and every
      // startup attempt failed before ever reaching `app.listen()`).
      // Instead the outage/recovery cycle only ever touches the
      // underlying Hardhat node (`restartHardhat`), which this
      // already-running server transparently recovers from on its next
      // real request once RPC connectivity returns — exactly the
      // behavior `funds-reader.ts`'s per-request (not per-process) error
      // handling is designed for.
      apiHandle = startApiServer({
        PATH: process.env.PATH ?? "",
        DATABASE_URL: requireTestDatabaseUrl(),
        BACKEND_RPC_URL: rpcUrl,
        CHAIN_ID: String(chainId),
        YD_TOKEN_ADDRESS: ydTokenAddress,
        TASK_ESCROW_ADDRESS: escrowAddress,
        ACCEPTANCE_PERMIT_SIGNER_KEY: authorizedSignerKey,
        FUNDING_REQUIRED_CONFIRMATIONS: "1",
        YD_FAUCET_ADDRESS: "0x9876543210987654321098765432109876543210",
        API_PORT: String(apiPort),
        // app.ts's real CORS config (`@fastify/cors`) defaults
        // `Access-Control-Allow-Origin` to `http://localhost:5173` — this
        // suite drives the browser against its own dedicated `vite
        // preview` instance (`webPreviewPort`, never 4173/the `?mock=1`
        // suite's own preview), which a real browser would otherwise
        // CORS-block the credentialed `/office/snapshot` fetch from
        // (discovered the hard way: without this, the embedded app's
        // fetch silently fails and `comp.snapshot` never populates).
        WEB_ORIGIN: `http://localhost:${webPreviewPort}`,
      });
      try {
        await waitForHttpReady(`http://localhost:${apiPort}/health`, 20_000);
      } catch (error) {
        throw new Error(`${String(error)}\napi server stderr:\n${apiHandle.stderr()}`);
      }

      // Real login: real HTTP calls against the real running server (not
      // `app.inject`), a real SIWE-style signature, a real Set-Cookie
      // response — exactly what a real browser's own login flow produces.
      const nonceResponse = await fetch(`http://localhost:${apiPort}/auth/nonce`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: viewer.address }),
      });
      const { nonce, issuedAt, expiresAt } = (await nonceResponse.json()) as {
        nonce: string;
        issuedAt: string;
        expiresAt: string;
      };
      const { buildSignInMessage } =
        (await import("../apps/api/dist/modules/auth/signInMessage.js")) as {
          buildSignInMessage: (params: {
            domain: string;
            address: `0x${string}`;
            nonce: string;
            issuedAt: Date;
            expiresAt: Date;
          }) => string;
        };
      const message = buildSignInMessage({
        domain: "localhost",
        address: viewer.address,
        nonce,
        issuedAt: new Date(issuedAt),
        expiresAt: new Date(expiresAt),
      });
      const signature = await viewer.signMessage({ message });
      const verifyResponse = await fetch(`http://localhost:${apiPort}/auth/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: viewer.address, signature, nonce }),
      });
      const setCookie = verifyResponse.headers.get("set-cookie");
      const match = /session_token=([^;]+)/.exec(String(setCookie));
      if (!match?.[1]) throw new Error("beforeAll: no session_token cookie in verify response");
      sessionToken = match[1];
    }, 90_000);

    test.afterAll(async () => {
      await killApiServer(apiHandle);
      hardhatProcess?.kill();
      webPreviewHandle?.kill();
      // Never left behind — see WEB_E2E_DIST_DIR's own doc comment.
      await rm(WEB_E2E_DIST_DIR, { recursive: true, force: true });
      // Scoped cleanup by known key — never a table-wide DROP (see file
      // header: this Postgres database is shared with other suites that
      // may run before/after this one). Order matters: sessions/
      // auth_nonces both FK-reference users(address), so users must be
      // deleted last.
      await pool?.query(`DELETE FROM tasks WHERE requester_address = $1`, [
        viewer.address.toLowerCase(),
      ]);
      await pool?.query(`DELETE FROM sessions WHERE address = $1`, [viewer.address.toLowerCase()]);
      await pool?.query(`DELETE FROM auth_nonces WHERE address = $1`, [
        viewer.address.toLowerCase(),
      ]);
      await pool?.query(`DELETE FROM users WHERE address = $1`, [viewer.address.toLowerCase()]);
      await pool?.end();
    });

    test("the funds zone shows real chain-derived data and a real degrade, with a real recovery in between", async ({
      page,
    }) => {
      test.setTimeout(180_000);

      async function loginAndGoto(): Promise<{ iframeEl: Locator; frame: FrameLocator }> {
        await page.context().addCookies([
          {
            name: "session_token",
            value: sessionToken,
            domain: "localhost",
            path: "/",
          },
        ]);
        // This describe block's own dedicated `vite preview` instance
        // (`webPreviewPort`) — built with `VITE_API_BASE_URL` pointing at
        // this describe block's real api server (`apiPort`); see
        // `beforeAll`'s own doc comment on why a real separate build was
        // necessary rather than rewriting the embedded iframe's URL at
        // request time.
        await page.goto(`http://localhost:${webPreviewPort}/office`);
        const found = getOfficeFrame(page);
        await waitForRealSceneRender(page, found.frame.locator("canvas").first());
        return found;
      }

      async function readFundsDetailText(): Promise<string> {
        const { iframeEl, frame } = await loginAndGoto();
        const canvas = frame.locator("canvas").first();
        await focusOfficeFrame(iframeEl, canvas);
        const realFrame = await getRealFrame(iframeEl);
        const hotspots = await getAllHotspots(realFrame);
        const funds = hotspots.find((h) => h.title === "托管资金区");
        if (!funds) throw new Error("托管资金区 hotspot not found in the real scene");
        const waypoints = wingWaypoints(funds);
        const finalPosition = await walkPath(page, realFrame, waypoints, 140);
        const distance = Math.hypot(funds.x - finalPosition.x, funds.y - finalPosition.y);
        expect(distance, "did not reach real interaction radius of 托管资金区").toBeLessThan(145);
        // Nudge the interaction state to (re-)evaluate now that the
        // player is in range — updateInteraction() only updates the label
        // on a *change* of nearest hotspot, and re-entering the page just
        // now means it hasn't run yet at this exact position.
        await page.waitForTimeout(300);
        return realFrame.evaluate(() => {
          interface SceneNode {
            name?: string;
            children?: SceneNode[];
            getComponent?: (name: string) => unknown;
          }
          const cc = (window as unknown as { cc?: { director?: { getScene?: () => SceneNode } } })
            .cc;
          function findNode(node: SceneNode | null | undefined, name: string): SceneNode | null {
            if (!node) return null;
            if (node.name === name) return node;
            for (const child of node.children ?? []) {
              const found = findNode(child, name);
              if (found) return found;
            }
            return null;
          }
          const scene = cc?.director?.getScene?.();
          const bootstrapNode = findNode(scene, "OfficeBootstrap");
          const comp = bootstrapNode?.getComponent?.("OfficeBootstrap") as
            { detailLabel?: { string?: string } } | undefined;
          return comp?.detailLabel?.string ?? "";
        });
      }

      await test.step("real RPC available: real chain-derived data renders", async () => {
        const text = await readFundsDetailText();
        expect(text).toContain("托管资金区");
        expect(text).toContain("YD");
        expect(text).not.toContain("暂不可用");
      });

      await test.step("real RPC unreachable: real RPC_UNAVAILABLE degrade renders", async () => {
        // Kills the real Hardhat node and leaves it down — the already
        // running api server's own next `/office/snapshot` request now
        // genuinely fails to reach it (a real refused connection, not a
        // mocked failure). See `restartHardhat`'s own doc comment for why
        // this doesn't touch the api server process itself.
        await restartHardhat(false);
        const text = await readFundsDetailText();
        expect(text).toContain("链上数据暂不可用");
      });

      await test.step("restore the real RPC: real recovery, same api server process throughout", async () => {
        // Respawns Hardhat on the same port and redeploys both contracts
        // to the same addresses (deterministic nonces — see
        // `deployContracts`'s own doc comment); the api server, still the
        // exact same process from `beforeAll`, was never restarted or
        // reconfigured.
        await restartHardhat(true);
        const text = await readFundsDetailText();
        expect(text).toContain("YD");
        expect(text).not.toContain("暂不可用");
      });
    });
  },
);
