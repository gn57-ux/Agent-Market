import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RatingSection } from "./RatingSection.js";
import * as ratingsApi from "./api.js";
import { ApiError } from "./api.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RatingSection", () => {
  it("shows the 1-5 submission form to the requester when unrated", async () => {
    vi.spyOn(ratingsApi, "getRating").mockRejectedValue(new ApiError(404, "该任务尚无评分记录。"));
    render(<RatingSection taskId="task-1" isRequester />);
    expect(await screen.findByText("为本次合作评分：")).toBeTruthy();
    for (const score of [1, 2, 3, 4, 5]) {
      expect(screen.getByRole("button", { name: String(score) })).toBeTruthy();
    }
  });

  it("shows nothing for a non-requester when unrated", async () => {
    vi.spyOn(ratingsApi, "getRating").mockRejectedValue(new ApiError(404, "该任务尚无评分记录。"));
    const { container } = render(<RatingSection taskId="task-1" isRequester={false} />);
    await waitFor(() => expect(ratingsApi.getRating).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });

  it("shows the read-only rating to ANY viewer once one exists — including a non-requester (score is not sensitive)", async () => {
    vi.spyOn(ratingsApi, "getRating").mockResolvedValue({
      ratingId: "rating-1",
      score: 4,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    render(<RatingSection taskId="task-1" isRequester={false} />);
    expect(await screen.findByText("已评分：4 / 5")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "5" })).toBeNull();
  });

  it("submits the clicked score and switches to the read-only display", async () => {
    vi.spyOn(ratingsApi, "getRating").mockRejectedValueOnce(
      new ApiError(404, "该任务尚无评分记录。"),
    );
    const submitSpy = vi
      .spyOn(ratingsApi, "submitRating")
      .mockResolvedValue({ ratingId: "rating-1" });

    render(<RatingSection taskId="task-1" isRequester />);
    const button = await screen.findByRole("button", { name: "5" });

    vi.spyOn(ratingsApi, "getRating").mockResolvedValue({
      ratingId: "rating-1",
      score: 5,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    fireEvent.click(button);

    expect(submitSpy).toHaveBeenCalledWith("task-1", 5);
    expect(await screen.findByText("已评分：5 / 5")).toBeTruthy();
  });

  it("shows an error message and keeps the form usable when submission fails", async () => {
    vi.spyOn(ratingsApi, "getRating").mockRejectedValue(new ApiError(404, "该任务尚无评分记录。"));
    vi.spyOn(ratingsApi, "submitRating").mockRejectedValue(new ApiError(500, "服务器错误"));

    render(<RatingSection taskId="task-1" isRequester />);
    const button = await screen.findByRole("button", { name: "3" });
    fireEvent.click(button);

    expect(await screen.findByText("服务器错误")).toBeTruthy();
    expect(screen.getByRole("button", { name: "3" }).hasAttribute("disabled")).toBe(false);
  });

  it("surfaces a non-404 load error instead of silently treating it as unrated", async () => {
    vi.spyOn(ratingsApi, "getRating").mockRejectedValue(new ApiError(500, "服务器错误"));
    render(<RatingSection taskId="task-1" isRequester />);
    expect(await screen.findByText("服务器错误")).toBeTruthy();
    expect(screen.queryByText("为本次合作评分：")).toBeNull();
  });
});
