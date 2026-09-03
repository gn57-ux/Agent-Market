import {
  _decorator,
  Camera,
  Canvas,
  Color,
  Component,
  EventKeyboard,
  Graphics,
  Input,
  input,
  KeyCode,
  Label,
  Node,
  UITransform,
  view,
} from "cc";
import { loadOfficeSnapshot, OfficeSnapshotError, type OfficeMockMode } from "./api/office-client";
import type { OfficeSnapshot } from "./domain/office-snapshot";
import {
  requestParentNavigation,
  type OfficeNavigationTarget,
} from "./navigation/parent-navigation";

const { ccclass } = _decorator;
const SPEED = 260;
const WORLD_HALF_WIDTH = 1800;
const WORLD_HALF_HEIGHT = 1400;
const CAMERA_LIMIT_X = 1160;
const CAMERA_LIMIT_Y = 1040;

interface Obstacle {
  readonly x: number;
  readonly y: number;
  readonly halfWidth: number;
  readonly halfHeight: number;
}

interface Hotspot {
  readonly node: Node;
  readonly title: string;
  readonly summary: (snapshot: OfficeSnapshot) => string;
  readonly target: (snapshot: OfficeSnapshot) => OfficeNavigationTarget;
}

@ccclass("OfficeBootstrap")
export class OfficeBootstrap extends Component {
  private player: Node | null = null;
  private cameraNode: Node | null = null;
  private detailPanel: Node | null = null;
  private detailLabel: Label | null = null;
  private taskOverviewLabel: Label | null = null;
  private taskPriorityLabel: Label | null = null;
  private readonly publishedTaskLabels: Label[] = [];
  private readonly acceptedTaskLabels: Label[] = [];
  private snapshot: OfficeSnapshot | null = null;
  private readonly pressed = new Set<KeyCode>();
  private readonly hotspots: Hotspot[] = [];
  private readonly obstacles: Obstacle[] = [];
  private activeHotspot: Hotspot | null = null;

  protected async start(): Promise<void> {
    view.setDesignResolutionSize(1280, 720, 2);
    this.buildRoom();
    input.on(Input.EventType.KEY_DOWN, this.onKeyDown, this);
    input.on(Input.EventType.KEY_UP, this.onKeyUp, this);
    try {
      const params = new URLSearchParams(window.location.search);
      this.snapshot = await loadOfficeSnapshot(
        this.readMockMode(params),
        params.get("apiBaseUrl") ?? "http://localhost:3001",
      );
      this.updateTaskControlRoom(this.snapshot);
      this.setDetail("WASD / 方向键移动 · 靠近功能区查看摘要 · Enter 进入业务页面");
    } catch (error: unknown) {
      const reason = error instanceof OfficeSnapshotError ? error.reason : "NETWORK";
      this.setDetail(`工作室数据暂不可用（${reason}）· 请使用上方普通 Web 工作台`);
    }
  }

  protected onDestroy(): void {
    input.off(Input.EventType.KEY_DOWN, this.onKeyDown, this);
    input.off(Input.EventType.KEY_UP, this.onKeyUp, this);
  }

  protected update(deltaTime: number): void {
    const player = this.player;
    if (!player) return;
    const horizontal =
      Number(this.pressed.has(KeyCode.KEY_D) || this.pressed.has(KeyCode.ARROW_RIGHT)) -
      Number(this.pressed.has(KeyCode.KEY_A) || this.pressed.has(KeyCode.ARROW_LEFT));
    const vertical =
      Number(this.pressed.has(KeyCode.KEY_W) || this.pressed.has(KeyCode.ARROW_UP)) -
      Number(this.pressed.has(KeyCode.KEY_S) || this.pressed.has(KeyCode.ARROW_DOWN));
    const length = Math.hypot(horizontal, vertical) || 1;
    const position = player.position;
    const candidateX = Math.max(
      -WORLD_HALF_WIDTH + 32,
      Math.min(WORLD_HALF_WIDTH - 32, position.x + (horizontal / length) * SPEED * deltaTime),
    );
    const candidateY = Math.max(
      -WORLD_HALF_HEIGHT + 36,
      Math.min(WORLD_HALF_HEIGHT - 36, position.y + (vertical / length) * SPEED * deltaTime),
    );
    if (!this.isBlocked(candidateX, position.y)) player.setPosition(candidateX, position.y);
    const positionAfterHorizontalMove = player.position;
    if (!this.isBlocked(positionAfterHorizontalMove.x, candidateY)) {
      player.setPosition(positionAfterHorizontalMove.x, candidateY);
    }
    this.updateCamera(deltaTime);
    this.updateInteraction();
  }

  private isBlocked(x: number, y: number): boolean {
    const blockedByHotspot = this.hotspots.some((hotspot) => {
      const position = hotspot.node.position;
      return Math.abs(x - position.x) < 137 && Math.abs(y - position.y) < 84;
    });
    if (blockedByHotspot) return true;
    return this.obstacles.some(
      (obstacle) =>
        Math.abs(x - obstacle.x) < obstacle.halfWidth + 18 &&
        Math.abs(y - obstacle.y) < obstacle.halfHeight + 24,
    );
  }

  private onKeyDown(event: EventKeyboard): void {
    this.pressed.add(event.keyCode);
    if (
      (event.keyCode === KeyCode.ENTER || event.keyCode === KeyCode.SPACE) &&
      this.activeHotspot &&
      this.snapshot
    ) {
      requestParentNavigation(this.activeHotspot.target(this.snapshot));
    }
  }

  private onKeyUp(event: EventKeyboard): void {
    this.pressed.delete(event.keyCode);
  }

  private buildRoom(): void {
    const canvasNode = this.node.scene?.getChildByName("Canvas") ?? null;
    if (!canvasNode?.getComponent(Canvas)) {
      throw new Error("OfficeBootstrap requires the scene's standard 2D Canvas node.");
    }
    canvasNode.getComponent(UITransform)?.setContentSize(1280, 720);
    this.cameraNode = canvasNode.getComponentInChildren(Camera)?.node ?? null;
    this.drawRect(canvasNode, "RoomShadow", 0, 0, 3640, 2840, new Color(3, 8, 20, 255));
    const room = this.drawRect(canvasNode, "Room", 0, 0, 3600, 2800, new Color(13, 23, 40, 255));
    this.buildRoomDressing(room);
    this.buildRoomWalls(canvasNode);
    this.addHotspot(
      canvasNode,
      "Agent 工位",
      "我的数字员工",
      -1500,
      650,
      new Color(47, 139, 253, 255),
      (snapshot) =>
        `${snapshot.agents.length} 个 Agent · ${snapshot.agents[0]?.name ?? "暂无 Agent"}`,
      (snapshot) =>
        snapshot.agents[0]
          ? { kind: "agent-detail", agentId: snapshot.agents[0].agentId }
          : { kind: "agent-market" },
    );
    this.addHotspot(
      canvasNode,
      "任务看板",
      "发布与接单",
      0,
      930,
      new Color(134, 88, 255, 255),
      (snapshot) =>
        `发布 ${snapshot.taskBoard.published.length} · 接单 ${snapshot.taskBoard.accepted.length}`,
      (snapshot) =>
        snapshot.taskBoard.published[0]
          ? { kind: "task-detail", taskId: snapshot.taskBoard.published[0].taskId }
          : { kind: "task-market" },
      false,
    );
    this.addHotspot(
      canvasNode,
      "托管资金区",
      "只读链上资产",
      1500,
      650,
      new Color(33, 194, 154, 255),
      (snapshot) =>
        snapshot.funds.kind === "available"
          ? `YD ${this.formatAmount(snapshot.funds.walletBalance)} · 已锁 ${this.formatAmount(snapshot.funds.lockedBudget)}`
          : "链上数据暂不可用",
      () => ({ kind: "my-workbench" }),
    );
    this.addHotspot(
      canvasNode,
      "交付工作台",
      "执行与验收",
      -1500,
      -650,
      new Color(247, 167, 67, 255),
      (snapshot) => `${snapshot.deliveryDesk.length} 个执行中交付`,
      (snapshot) =>
        snapshot.deliveryDesk[0]
          ? { kind: "task-detail", taskId: snapshot.deliveryDesk[0].taskId }
          : { kind: "my-workbench" },
    );
    this.addHotspot(
      canvasNode,
      "成就墙",
      "质量与信誉",
      0,
      -1050,
      new Color(239, 89, 123, 255),
      (snapshot) =>
        `完成 ${snapshot.achievements.completedTaskCount} · 质量 ${snapshot.achievements.qualityScore ?? "—"}`,
      () => ({ kind: "my-workbench" }),
    );
    this.addHotspot(
      canvasNode,
      "Web 导航",
      "返回业务页面",
      1500,
      -650,
      new Color(84, 195, 244, 255),
      () => "Agent 市场 · 任务市场 · 发布 · 工作台",
      () => ({ kind: "web-home" }),
    );
    this.player = this.createPlayer(canvasNode);
    this.detailPanel = this.drawRect(
      canvasNode,
      "DetailPanel",
      0,
      -320,
      1120,
      62,
      new Color(8, 14, 27, 245),
    );
    this.detailLabel = this.addLabel(this.detailPanel, "正在加载工作室数据…", 18, Color.WHITE);
  }

  private addHotspot(
    parent: Node,
    title: string,
    subtitle: string,
    x: number,
    y: number,
    color: Color,
    summary: Hotspot["summary"],
    target: Hotspot["target"],
    renderCard = true,
  ): void {
    let zone: Node;
    if (renderCard) {
      this.drawRect(parent, `${title}Shadow`, x + 7, y - 8, 250, 120, new Color(4, 10, 24, 210));
      zone = this.drawRect(parent, title, x, y, 240, 110, color);
      this.drawRect(zone, "HeaderGlow", 0, 42, 208, 5, new Color(255, 255, 255, 95));
      this.addLabel(zone, title, 23, Color.WHITE, 0, 220, 48);
      this.addLabel(zone, subtitle, 14, new Color(235, 244, 255, 220), -30, 210, 28);
    } else {
      zone = new Node(title);
      zone.setPosition(x, y);
      zone.addComponent(UITransform).setContentSize(300, 120);
      parent.addChild(zone);
    }
    this.hotspots.push({ node: zone, title, summary, target });
  }

  private updateInteraction(): void {
    const player = this.player;
    if (!player) return;
    const nearest =
      this.hotspots.find(
        (hotspot) =>
          Math.hypot(
            player.position.x - hotspot.node.position.x,
            player.position.y - hotspot.node.position.y,
          ) < 145,
      ) ?? null;
    if (nearest === this.activeHotspot) return;
    this.activeHotspot = nearest;
    if (!nearest) {
      this.setDetail("靠近高亮功能区查看真实业务摘要");
    } else if (this.snapshot) {
      this.setDetail(`${nearest.title}：${nearest.summary(this.snapshot)} · 按 Enter 进入`);
    }
  }

  private buildRoomDressing(room: Node): void {
    for (let x = -1720; x <= 1720; x += 80) {
      this.drawRect(room, `FloorLineV${x}`, x, 0, 2, 2480, new Color(67, 92, 128, 24));
    }
    for (let y = -1320; y <= 1320; y += 80) {
      this.drawRect(room, `FloorLineH${y}`, 0, y, 3440, 2, new Color(67, 92, 128, 24));
    }
    const plazaColor = new Color(26, 47, 76, 255);
    const corridorColor = new Color(22, 39, 64, 255);
    this.drawRect(room, "CentralPlaza", 0, 0, 900, 700, plazaColor);
    this.drawRect(room, "NorthCorridor", 0, 575, 220, 500, corridorColor);
    this.drawRect(room, "SouthCorridor", 0, -575, 220, 500, corridorColor);
    this.drawRect(room, "WestCorridor", -725, 0, 550, 220, corridorColor);
    this.drawRect(room, "EastCorridor", 725, 0, 550, 220, corridorColor);
    this.drawRect(room, "WestWingSpine", -1100, 0, 220, 1800, corridorColor);
    this.drawRect(room, "EastWingSpine", 1100, 0, 220, 1800, corridorColor);
    this.addThemedRoomFloor(room, "TaskRoom", 0, 1050, 900, 600, new Color(49, 36, 91, 255));
    this.addThemedRoomFloor(
      room,
      "AchievementRoom",
      0,
      -1050,
      700,
      500,
      new Color(77, 31, 58, 255),
    );
    this.addThemedRoomFloor(room, "AgentRoom", -1500, 650, 600, 500, new Color(20, 48, 83, 255));
    this.addThemedRoomFloor(
      room,
      "DeliveryRoom",
      -1500,
      -650,
      600,
      500,
      new Color(78, 50, 25, 255),
    );
    this.addThemedRoomFloor(room, "FundsRoom", 1500, 650, 600, 500, new Color(15, 67, 65, 255));
    this.addThemedRoomFloor(room, "WebRoom", 1500, -650, 600, 500, new Color(18, 58, 82, 255));
    this.buildTaskControlRoom(room);
    this.drawRect(room, "CentralGuideHorizontal", 0, 0, 820, 5, new Color(69, 119, 193, 145));
    this.drawRect(room, "CentralGuideVertical", 0, 0, 5, 620, new Color(69, 119, 193, 145));
    this.drawCircle(room, "PlazaOuterRing", 0, 0, 260, new Color(41, 70, 109, 235), 0.78);
    this.drawCircle(room, "PlazaInnerRing", 0, 0, 190, new Color(31, 55, 88, 255), 0.78);
    this.drawCircle(room, "PlazaCore", 0, 0, 112, new Color(37, 65, 103, 255), 0.78);
    this.addPlazaSign(room, "中央协作广场", 0, 0);
    this.addPlazaSign(room, "← 西侧工作区", -300, 0);
    this.addPlazaSign(room, "任务控制室 ↑", 0, 250);
    this.addPlazaSign(room, "成就陈列室 ↓", 0, -250);
    this.addPlazaSign(room, "东侧资产区 →", 300, 0);
    this.addRoomLabel(room, "AGENT LAB", -1500, 835);
    this.addRoomLabel(room, "TREASURY", 1500, 835);
    this.addRoomLabel(room, "DELIVERY", -1500, -835);
    this.addRoomLabel(room, "REPUTATION", 0, -1235);
    this.addRoomLabel(room, "WEB PORTAL", 1500, -835);
  }

  private buildTaskControlRoom(parent: Node): void {
    const panel = new Color(14, 24, 48, 245);
    const panelEdge = new Color(111, 83, 210, 255);
    const muted = new Color(157, 177, 211, 235);

    this.drawRect(parent, "TaskBackWallShadow", 7, 1238, 802, 190, new Color(3, 8, 20, 205));
    const backWall = this.drawRect(
      parent,
      "TaskBackWall",
      0,
      1246,
      800,
      188,
      new Color(29, 34, 68, 255),
    );
    this.drawRect(backWall, "BackWallTopRail", 0, 88, 770, 7, new Color(129, 91, 239, 220));
    this.drawRect(backWall, "BackWallLowerRail", 0, -88, 750, 5, new Color(45, 62, 96, 255));
    this.drawRect(parent, "TaskStatusShadow", 5, 1240, 714, 144, new Color(3, 8, 20, 190));
    const statusBoard = this.drawRect(parent, "TaskStatusBoard", 0, 1248, 710, 142, panel);
    this.drawRect(statusBoard, "TaskStatusTop", 0, 67, 680, 5, panelEdge);
    this.addLabel(statusBoard, "任务状态流水线", 16, Color.WHITE, 45, 300, 28);
    const statusNames = ["草稿", "待出资", "开放", "已接单", "已提交", "已完成"];
    const statusColors = [
      new Color(112, 124, 145, 255),
      new Color(237, 187, 72, 255),
      new Color(47, 139, 253, 255),
      new Color(134, 88, 255, 255),
      new Color(247, 167, 67, 255),
      new Color(33, 194, 154, 255),
    ];
    for (let index = 0; index < statusNames.length; index += 1) {
      const x = -285 + index * 114;
      if (index < statusNames.length - 1) {
        this.drawRect(statusBoard, `StatusLink${index}`, x + 57, -10, 74, 3, muted);
      }
      this.drawCircle(statusBoard, `StatusRing${index}`, x, -10, 18, new Color(5, 12, 28, 255));
      this.drawCircle(statusBoard, `StatusDot${index}`, x, -10, 12, statusColors[index] ?? muted);
      this.addPositionedLabel(statusBoard, statusNames[index] ?? "", x, -44, 11, muted, 92, 22);
    }
    this.drawCircle(statusBoard, "DisputeDot", 172, -47, 9, new Color(226, 91, 91, 255));
    this.addPositionedLabel(
      statusBoard,
      "争议",
      203,
      -47,
      11,
      new Color(240, 150, 150, 240),
      62,
      20,
    );

    this.buildTaskCardColumn(parent, "我的发布", -330, this.publishedTaskLabels, panelEdge);
    this.buildTaskCardColumn(
      parent,
      "我的接单",
      330,
      this.acceptedTaskLabels,
      new Color(77, 138, 222, 255),
    );

    this.drawRect(parent, "PriorityShadow", 7, 1087, 324, 124, new Color(3, 8, 20, 205));
    const priority = this.drawRect(
      parent,
      "PriorityTask",
      0,
      1096,
      320,
      120,
      new Color(65, 37, 96, 255),
    );
    this.drawRect(priority, "PriorityTop", 0, 56, 292, 6, new Color(177, 118, 255, 255));
    this.addLabel(priority, "当前优先任务", 14, new Color(226, 213, 255, 255), 33, 270, 26);
    this.taskPriorityLabel = this.addLabel(priority, "等待任务数据", 15, Color.WHITE, -13, 278, 50);
    this.drawCircle(parent, "PriorityProjectorBase", 0, 1018, 42, new Color(12, 21, 43, 255), 0.36);
    this.drawCircle(
      parent,
      "PriorityProjectorGlow",
      0,
      1022,
      24,
      new Color(104, 184, 255, 150),
      0.32,
    );

    this.drawRect(parent, "TaskConsoleShadow", 7, 858, 382, 122, new Color(3, 8, 20, 210));
    const consoleNode = this.drawRect(
      parent,
      "TaskOverviewConsole",
      0,
      872,
      378,
      118,
      new Color(20, 35, 63, 255),
    );
    this.drawRect(consoleNode, "ConsoleFace", 0, -51, 348, 18, new Color(9, 17, 34, 230));
    this.drawRect(consoleNode, "ConsoleTop", 0, 53, 344, 6, panelEdge);
    this.addLabel(consoleNode, "任务概览控制台", 13, muted, 35, 300, 24);
    this.taskOverviewLabel = this.addLabel(
      consoleNode,
      "我的发布 —   我的接单 —",
      17,
      Color.WHITE,
      -9,
      340,
      46,
    );
  }

  private buildTaskCardColumn(
    parent: Node,
    title: string,
    x: number,
    labels: Label[],
    accent: Color,
  ): void {
    this.addPositionedLabel(parent, title, x, 1150, 16, Color.WHITE, 210, 28);
    for (let index = 0; index < 3; index += 1) {
      const y = 1083 - index * 93;
      this.drawRect(
        parent,
        `${title}CardShadow${index}`,
        x + 6,
        y - 7,
        224,
        76,
        new Color(3, 8, 20, 190),
      );
      const card = this.drawRect(
        parent,
        `${title}Card${index}`,
        x,
        y,
        220,
        74,
        new Color(22, 34, 61, 255),
      );
      this.drawRect(card, "Accent", -104, 0, 7, 58, accent);
      this.drawRect(
        card,
        "CardHeader",
        4,
        31,
        188,
        3,
        new Color(accent.r, accent.g, accent.b, 115),
      );
      labels.push(this.addLabel(card, "暂无任务", 11, new Color(210, 221, 240, 255), -1, 190, 60));
    }
  }

  private updateTaskControlRoom(snapshot: OfficeSnapshot): void {
    if (this.taskOverviewLabel) {
      this.taskOverviewLabel.string = `我的发布 ${snapshot.taskBoard.published.length}   我的接单 ${snapshot.taskBoard.accepted.length}`;
    }
    const priorityTask = snapshot.taskBoard.accepted[0] ?? snapshot.taskBoard.published[0];
    if (this.taskPriorityLabel) {
      this.taskPriorityLabel.string = priorityTask
        ? `${priorityTask.title}\n${priorityTask.status} · YD ${this.formatAmount(priorityTask.budget)}`
        : "暂无优先任务";
    }
    this.updateTaskCardLabels(this.publishedTaskLabels, snapshot.taskBoard.published);
    this.updateTaskCardLabels(this.acceptedTaskLabels, snapshot.taskBoard.accepted);
  }

  private updateTaskCardLabels(
    labels: readonly Label[],
    tasks: OfficeSnapshot["taskBoard"]["published"],
  ): void {
    for (let index = 0; index < labels.length; index += 1) {
      const label = labels[index];
      const task = tasks[index];
      if (!label) continue;
      label.string = task
        ? `${task.title}\n${task.status} · YD ${this.formatAmount(task.budget)}`
        : "暂无任务";
    }
  }

  private addThemedRoomFloor(
    parent: Node,
    name: string,
    x: number,
    y: number,
    width: number,
    height: number,
    color: Color,
  ): void {
    this.drawRect(parent, `${name}Floor`, x, y, width, height, color);
    this.drawRect(
      parent,
      `${name}Inset`,
      x,
      y,
      width - 54,
      height - 54,
      new Color(color.r, color.g, color.b, 120),
    );
  }

  private buildRoomWalls(parent: Node): void {
    const wallColor = new Color(49, 68, 94, 255);
    const wallEdge = new Color(91, 127, 173, 220);
    const wall = (name: string, x: number, y: number, width: number, height: number) =>
      this.addWall(parent, name, x, y, width, height, wallColor, wallEdge);

    wall("PlazaNorthWest", -280, 350, 340, 24);
    wall("PlazaNorthEast", 280, 350, 340, 24);
    wall("PlazaSouthWest", -280, -350, 340, 24);
    wall("PlazaSouthEast", 280, -350, 340, 24);
    wall("PlazaWestNorth", -450, 230, 24, 240);
    wall("PlazaWestSouth", -450, -230, 24, 240);
    wall("PlazaEastNorth", 450, 230, 24, 240);
    wall("PlazaEastSouth", 450, -230, 24, 240);

    wall("NorthCorridorWest", -110, 575, 24, 450);
    wall("NorthCorridorEast", 110, 575, 24, 450);
    wall("SouthCorridorWest", -110, -575, 24, 450);
    wall("SouthCorridorEast", 110, -575, 24, 450);
    wall("WestCorridorNorth", -725, 110, 550, 24);
    wall("WestCorridorSouth", -725, -110, 550, 24);
    wall("EastCorridorNorth", 725, 110, 550, 24);
    wall("EastCorridorSouth", 725, -110, 550, 24);

    wall("TaskNorth", 0, 1350, 900, 24);
    wall("TaskWest", -450, 1050, 24, 600);
    wall("TaskEast", 450, 1050, 24, 600);
    wall("TaskSouthWest", -280, 750, 340, 24);
    wall("TaskSouthEast", 280, 750, 340, 24);
    wall("AchievementSouth", 0, -1300, 700, 24);
    wall("AchievementWest", -350, -1050, 24, 500);
    wall("AchievementEast", 350, -1050, 24, 500);
    wall("AchievementNorthWest", -230, -800, 240, 24);
    wall("AchievementNorthEast", 230, -800, 240, 24);

    this.buildWingWalls(wall, -1);
    this.buildWingWalls(wall, 1);
  }

  private buildWingWalls(
    wall: (name: string, x: number, y: number, width: number, height: number) => void,
    direction: -1 | 1,
  ): void {
    const side = direction < 0 ? "West" : "East";
    const spineInnerX = direction * 1000;
    const spineOuterX = direction * 1200;
    const roomCenterX = direction * 1500;
    wall(`${side}SpineInnerNorth`, spineInnerX, 505, 24, 790);
    wall(`${side}SpineInnerSouth`, spineInnerX, -505, 24, 790);

    for (const y of [650, -650]) {
      const roomName = y > 0 ? `${side}UpperRoom` : `${side}LowerRoom`;
      wall(`${roomName}North`, roomCenterX, y + 250, 600, 24);
      wall(`${roomName}South`, roomCenterX, y - 250, 600, 24);
      wall(`${roomName}Outer`, direction * 1800, y, 24, 500);
      wall(`${roomName}DoorUpper`, spineOuterX, y + 180, 24, 140);
      wall(`${roomName}DoorLower`, spineOuterX, y - 180, 24, 140);
    }
  }

  private addPlazaSign(parent: Node, text: string, x: number, y: number): void {
    const sign = this.drawRect(parent, `${text}Sign`, x, y, 230, 38, new Color(12, 24, 42, 225));
    this.addLabel(sign, text, 13, new Color(131, 171, 221, 235), 0, 220, 30);
  }

  private addWall(
    parent: Node,
    name: string,
    x: number,
    y: number,
    width: number,
    height: number,
    color: Color,
    edgeColor: Color,
  ): void {
    this.drawRect(parent, `${name}Shadow`, x + 5, y - 6, width, height, new Color(2, 7, 18, 170));
    const wall = this.drawRect(parent, name, x, y, width, height, color);
    const faceThickness = Math.min(8, width / 3, height / 3);
    this.drawRect(
      wall,
      "BottomFace",
      0,
      -height / 2 + faceThickness / 2,
      Math.max(2, width - 4),
      faceThickness,
      new Color(22, 32, 48, 230),
    );
    this.drawRect(
      wall,
      "SideFace",
      width / 2 - faceThickness / 2,
      0,
      faceThickness,
      Math.max(2, height - 6),
      new Color(31, 44, 64, 230),
    );
    this.drawRect(
      wall,
      "TopHighlight",
      0,
      height / 2 - Math.min(3, height / 2),
      Math.max(2, width - 4),
      Math.min(5, height),
      edgeColor,
    );
    this.drawRect(
      wall,
      "InnerHighlight",
      -width / 2 + Math.min(4, width / 2),
      0,
      Math.min(4, width),
      Math.max(2, height - 8),
      new Color(112, 143, 181, 105),
    );
    this.obstacles.push({ x, y, halfWidth: width / 2, halfHeight: height / 2 });
  }

  private addRoomLabel(parent: Node, text: string, x: number, y: number): void {
    const plate = this.drawRect(parent, `${text}Plate`, x, y, 190, 32, new Color(10, 19, 34, 220));
    this.addLabel(plate, text, 12, new Color(112, 153, 208, 230), 0, 180, 26);
  }

  private updateCamera(deltaTime: number): void {
    const player = this.player;
    const camera = this.cameraNode;
    if (!player || !camera) return;
    const targetX = Math.max(-CAMERA_LIMIT_X, Math.min(CAMERA_LIMIT_X, player.position.x));
    const targetY = Math.max(-CAMERA_LIMIT_Y, Math.min(CAMERA_LIMIT_Y, player.position.y));
    const blend = Math.min(1, deltaTime * 5);
    const current = camera.position;
    const nextX = current.x + (targetX - current.x) * blend;
    const nextY = current.y + (targetY - current.y) * blend;
    camera.setPosition(nextX, nextY, current.z);
    this.detailPanel?.setPosition(nextX, nextY - 320);
  }

  private createPlayer(parent: Node): Node {
    const player = new Node("Player");
    player.addComponent(UITransform).setContentSize(40, 54);
    player.setPosition(0, 0);
    parent.addChild(player);
    this.drawCircle(player, "Shadow", 0, -26, 23, new Color(2, 7, 18, 120), 0.42);
    this.drawRect(player, "Body", 0, -5, 38, 42, new Color(255, 199, 77, 255));
    this.drawRect(player, "BodyHighlight", -10, -2, 6, 26, new Color(255, 232, 151, 230));
    this.drawCircle(player, "Head", 0, 20, 16, new Color(255, 225, 122, 255));
    this.drawRect(player, "Visor", 3, 21, 19, 7, new Color(35, 61, 91, 255));
    return player;
  }

  private drawCircle(
    parent: Node,
    name: string,
    x: number,
    y: number,
    radius: number,
    color: Color,
    scaleY = 1,
  ): Node {
    const node = new Node(name);
    node.setPosition(x, y);
    node.setScale(1, scaleY);
    node.addComponent(UITransform).setContentSize(radius * 2, radius * 2);
    const graphics = node.addComponent(Graphics);
    graphics.fillColor = color;
    graphics.circle(0, 0, radius);
    graphics.fill();
    parent.addChild(node);
    return node;
  }

  private drawRect(
    parent: Node,
    name: string,
    x: number,
    y: number,
    width: number,
    height: number,
    color: Color,
  ): Node {
    const node = new Node(name);
    node.setPosition(x, y);
    node.addComponent(UITransform).setContentSize(width, height);
    const graphics = node.addComponent(Graphics);
    graphics.fillColor = color;
    graphics.roundRect(-width / 2, -height / 2, width, height, Math.min(14, width / 2, height / 2));
    graphics.fill();
    parent.addChild(node);
    return node;
  }

  private addLabel(
    parent: Node,
    text: string,
    fontSize: number,
    color: Color,
    y = 0,
    width?: number,
    height?: number,
  ): Label {
    const node = new Node("Label");
    node.setPosition(0, y);
    const transform = node.addComponent(UITransform);
    const parentSize = parent.getComponent(UITransform)?.contentSize;
    transform.setContentSize(width ?? parentSize?.width ?? 220, height ?? parentSize?.height ?? 60);
    const label = node.addComponent(Label);
    label.string = text;
    label.fontSize = fontSize;
    label.lineHeight = fontSize + 6;
    label.color = color;
    label.horizontalAlign = Label.HorizontalAlign.CENTER;
    label.verticalAlign = Label.VerticalAlign.CENTER;
    parent.addChild(node);
    return label;
  }

  private addPositionedLabel(
    parent: Node,
    text: string,
    x: number,
    y: number,
    fontSize: number,
    color: Color,
    width: number,
    height: number,
  ): Label {
    const label = this.addLabel(parent, text, fontSize, color, y, width, height);
    label.node.setPosition(x, y);
    return label;
  }

  private setDetail(message: string): void {
    if (this.detailLabel) this.detailLabel.string = message;
  }

  private readMockMode(params: URLSearchParams): OfficeMockMode {
    const value = params.get("mock");
    if (value === "1") return "populated";
    if (value === "empty") return "empty";
    return null;
  }

  private formatAmount(minimalUnits: string): string {
    const padded = minimalUnits.padStart(19, "0");
    const whole = padded.slice(0, -18).replace(/^0+(?=\d)/, "");
    const fraction = padded.slice(-18, -16).replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : whole;
  }
}
