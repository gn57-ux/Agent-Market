import type { ZodError } from "zod";

/**
 * 唯一负责把 `ZodError` 转成人类可读中文提示的地方——修复前，`auth`/`agents`/
 * `tasks` 三个模块的 `safeParse` 失败分支各自直接把 `error.message` 发给
 * 客户端；Zod 的 `ZodError.prototype.message` getter 返回的是
 * `JSON.stringify(this.issues)`，一段原始 JSON issue 数组字符串（例如
 * `[{"code":"too_small","path":["title"],"message":"标题不能为空"}]`），
 * 前端 `client.ts` 的 `readErrorMessage` 只检查它是不是字符串就原样展示，
 * 用户看到的是这段 JSON，不是"标题不能为空"这句本该展示的中文提示。
 *
 * 每条 issue 的 `message` 字段本身已经是各 `schema.ts` 定义校验规则时写好的
 * 中文提示（业务规则的归属没有变，仍然只在各自的 schema 里定义一次）——这里
 * 只负责把多条 issue 的 message 拼接成一句人类可读的话，不重新定义或改写
 * 任何具体校验规则本身。三个模块共用同一个函数，而不是各自实现一遍拼接
 * 逻辑，避免以后只改了一处、其他模块又不同步。
 */
export function formatZodError(error: ZodError): string {
  const messages = error.issues
    .map((issue) => issue.message)
    .filter((message) => message.length > 0);
  return messages.length > 0 ? messages.join("；") : "请求参数不合法。";
}
