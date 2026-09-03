import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SignInButton } from "./SignInButton.js";

const login = vi.fn();
const loginWithPrivy = vi.fn();
const logout = vi.fn();

let mockSession: {
  status: "signed_out" | "signing_in" | "signed_in" | "error";
  address: string | undefined;
  errorMessage: string | undefined;
};

vi.mock("./SessionProvider.js", () => ({
  useSession: () => ({ ...mockSession, login, loginWithPrivy, logout }),
}));

const ADDRESS = "0x1234567890123456789012345678901234567890";

describe("SignInButton", () => {
  it("uses light-canvas tokens by default when signed in", () => {
    mockSession = { status: "signed_in", address: ADDRESS, errorMessage: undefined };
    render(<SignInButton />);

    const addressLabel = screen.getByText(`已登录：${ADDRESS}`);
    expect(addressLabel.className).toContain("text-ink-secondary");
    expect(addressLabel.className).not.toContain("text-ink-muted-on-dark");
  });

  it("uses dark-canvas tokens in the dark variant when signed in (Task E review: homepage hero color coordination)", () => {
    mockSession = { status: "signed_in", address: ADDRESS, errorMessage: undefined };
    render(<SignInButton variant="dark" />);

    const addressLabel = screen.getByText(`已登录：${ADDRESS}`);
    expect(addressLabel.className).toContain("text-ink-muted-on-dark");
    expect(addressLabel.className).not.toContain("text-ink-secondary");

    const logoutButton = screen.getByRole("button", { name: "登出" });
    expect(logoutButton.className).toContain("border-divider-dark");
    expect(logoutButton.className).not.toContain("border-divider-light");
  });

  describe("F-1601: Privy entry point coexists with MetaMask, not a replacement", () => {
    it("renders both the MetaMask and the Privy login buttons when signed out — a new visitor must see both options", () => {
      mockSession = { status: "signed_out", address: undefined, errorMessage: undefined };
      render(<SignInButton />);

      // getByRole throws (failing the test) if no matching element exists —
      // reaching the assertions below is itself the "both render" proof.
      expect(screen.getByRole("button", { name: "登录（签名验证钱包身份）" }).tagName).toBe(
        "BUTTON",
      );
      expect(screen.getByRole("button", { name: "用 Privy 登录" }).tagName).toBe("BUTTON");
    });

    it("clicking the Privy button calls session.loginWithPrivy(), not session.login()", () => {
      mockSession = { status: "signed_out", address: undefined, errorMessage: undefined };
      render(<SignInButton />);

      fireEvent.click(screen.getByRole("button", { name: "用 Privy 登录" }));

      expect(loginWithPrivy).toHaveBeenCalledTimes(1);
      expect(login).not.toHaveBeenCalled();
    });

    it("disables both login buttons together while signing_in — SessionProvider owns one shared state machine for both methods", () => {
      mockSession = { status: "signing_in", address: undefined, errorMessage: undefined };
      render(<SignInButton />);

      // Both buttons render the same "登录中…" label while signing_in
      // (neither SignInButton nor SessionProvider tracks "which method is
      // in flight" as a separate sub-state — see SignInButton.tsx's doc
      // comment on this deliberate simplification).
      const signingInButtons = screen.getAllByRole("button", { name: "登录中…" });
      expect(signingInButtons).toHaveLength(2);
      for (const button of signingInButtons) {
        expect((button as HTMLButtonElement).disabled).toBe(true);
      }
    });

    it("surfaces session.errorMessage (e.g. a rejected/unconfigured Privy attempt) next to the signed-out buttons", () => {
      mockSession = {
        status: "error",
        address: undefined,
        errorMessage: "Privy 登录当前不可用（未配置），请使用 MetaMask 登录。",
      };
      render(<SignInButton />);

      // SignInButton renders `{" "}{session.errorMessage}` (matching the
      // signed_in branch's own established pattern), hence the leading
      // space in the rendered textContent below.
      expect(
        screen.getByText("Privy 登录当前不可用（未配置），请使用 MetaMask 登录。").textContent,
      ).toBe(" Privy 登录当前不可用（未配置），请使用 MetaMask 登录。");
    });

    // T-1611 (defect B): SessionProvider.loginWithPrivy()'s already_consumed/
    // invalid_proof/network-failure recovery path lands on status
    // "signed_out" (not "error") once it has cleaned up the Privy SDK's own
    // session — the message still has to reach the user on this status too,
    // or the recovery is invisible and looks like the button silently did
    // nothing.
    it("also surfaces session.errorMessage when status is signed_out (T-1611: the Privy already_consumed/invalid_proof recovery path lands here, not on 'error')", () => {
      mockSession = {
        status: "signed_out",
        address: undefined,
        errorMessage: "Privy 登录凭证已失效，请重新登录。",
      };
      render(<SignInButton />);

      expect(screen.getByText("Privy 登录凭证已失效，请重新登录。").textContent).toBe(
        " Privy 登录凭证已失效，请重新登录。",
      );
    });
  });
});
