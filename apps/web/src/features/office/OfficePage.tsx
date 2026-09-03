import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { apiBaseUrl } from "../../shared/api/client.js";
import { officeFrameUrl } from "./office-frame-url.js";
import { officeTargetPath, readOfficeNavigationMessage } from "./office-navigation.js";

type FrameState = "loading" | "ready" | "failed";

export function OfficePage() {
  const navigate = useNavigate();
  const officeContainerRef = useRef<HTMLDivElement>(null);
  const [frameState, setFrameState] = useState<FrameState>("loading");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  const officeUrl = useMemo(
    () => officeFrameUrl(apiBaseUrl(), new URLSearchParams(window.location.search).get("mock")),
    [],
  );

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setFrameState((state) => (state === "loading" ? "failed" : state)),
      12_000,
    );
    const receive = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin) return;
      const target = readOfficeNavigationMessage(event.data);
      if (target) navigate(officeTargetPath(target));
    };
    window.addEventListener("message", receive);
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("message", receive);
    };
  }, [navigate]);

  useEffect(() => {
    const updateFullscreenState = () => {
      setIsFullscreen(document.fullscreenElement === officeContainerRef.current);
    };
    document.addEventListener("fullscreenchange", updateFullscreenState);
    return () => document.removeEventListener("fullscreenchange", updateFullscreenState);
  }, []);

  const toggleFullscreen = async () => {
    setFullscreenError(null);
    try {
      if (document.fullscreenElement === officeContainerRef.current) {
        await document.exitFullscreen();
        return;
      }
      const officeContainer = officeContainerRef.current;
      if (!officeContainer) {
        setFullscreenError("工作室尚未加载完成");
        return;
      }
      await officeContainer.requestFullscreen();
    } catch {
      setFullscreenError("浏览器未允许全屏，请再次点击或检查浏览器权限");
    }
  };

  return (
    <section className="mx-auto w-full max-w-7xl px-4 py-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.22em] text-action-blue">
            Phase 3
          </p>
          <h1 className="text-3xl font-bold text-ink-primary">个人虚拟工作室</h1>
        </div>
        <Link
          to="/tasks/accepted"
          className="rounded-lg border border-action-blue px-4 py-2 text-action-blue hover:bg-action-blue/10"
        >
          打开普通工作台
        </Link>
      </div>
      <p className="mb-4 text-ink-secondary">
        使用 WASD 或方向键移动，靠近区域查看真实业务摘要，按 Enter 进入现有页面。
      </p>
      <div
        ref={officeContainerRef}
        className="relative aspect-video min-h-[420px] overflow-hidden rounded-2xl border border-white/10 bg-slate-950 shadow-2xl fullscreen:h-screen fullscreen:w-screen fullscreen:aspect-auto fullscreen:rounded-none fullscreen:border-0"
      >
        <div className="absolute right-4 top-4 z-20 flex items-center gap-3">
          {fullscreenError && (
            <span role="alert" className="rounded-lg bg-red-950/90 px-3 py-2 text-sm text-white">
              {fullscreenError}
            </span>
          )}
          <button
            type="button"
            onClick={() => void toggleFullscreen()}
            className="rounded-lg border border-white/30 bg-slate-950/85 px-4 py-2 font-semibold text-white shadow-lg backdrop-blur hover:bg-slate-800 focus:outline-none focus:ring-2 focus:ring-action-blue"
          >
            {isFullscreen ? "退出全屏" : "全屏展示"}
          </button>
        </div>
        {frameState !== "failed" ? (
          <iframe
            title="Agent Market 个人虚拟工作室"
            src={officeUrl}
            className="h-full w-full border-0"
            onLoad={() => setFrameState("ready")}
            onError={() => setFrameState("failed")}
            allow="fullscreen"
            allowFullScreen
          />
        ) : (
          <div
            role="alert"
            className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center text-white"
          >
            <h2 className="text-2xl font-semibold">虚拟工作室暂时无法加载</h2>
            <p className="max-w-xl text-slate-300">
              任务、资金和 Agent 数据仍可在普通 Web 工作台查看；Cocos 展示层失败不会影响业务流程。
            </p>
            <Link
              to="/tasks/accepted"
              className="rounded-lg bg-action-blue px-5 py-3 font-semibold text-white"
            >
              进入普通工作台
            </Link>
          </div>
        )}
        {frameState === "loading" && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-950 text-white">
            正在加载工作室…
          </div>
        )}
      </div>
    </section>
  );
}
