import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AgentForm,
  agentFormValuesFromAgent,
  agentFormValuesToInput,
  emptyAgentFormValues,
} from "./AgentForm.js";

describe("agentFormValuesToInput", () => {
  it("splits and trims the comma-separated skill tags field", () => {
    const values = { ...emptyAgentFormValues(), skillTagsText: " copywriting ,editing,, seo " };
    expect(agentFormValuesToInput(values).skillTags).toEqual(["copywriting", "editing", "seo"]);
  });

  it("omits optional fields left blank rather than sending empty strings", () => {
    const values = emptyAgentFormValues();
    const input = agentFormValuesToInput(values);
    expect(input.authorBio).toBeUndefined();
    expect(input.invocationUrl).toBeUndefined();
    expect(input.pricingModel).toBeUndefined();
    expect(input.referencePrice).toBeUndefined();
  });

  it("parses referencePriceText into a number only when non-blank", () => {
    expect(
      agentFormValuesToInput({ ...emptyAgentFormValues(), referencePriceText: "12.5" })
        .referencePrice,
    ).toBe(12.5);
    expect(
      agentFormValuesToInput({ ...emptyAgentFormValues(), referencePriceText: "  " })
        .referencePrice,
    ).toBeUndefined();
  });
});

describe("agentFormValuesFromAgent", () => {
  it("joins skillTags back into a comma-separated string and maps null to empty string", () => {
    const values = agentFormValuesFromAgent({
      name: "A",
      description: "d",
      category: "writing",
      skillTags: ["a", "b"],
      authorBio: null,
      invocationUrl: null,
      payoutAddress: "0xabc",
      pricingModel: null,
      referencePrice: null,
    });
    expect(values.skillTagsText).toBe("a, b");
    expect(values.authorBio).toBe("");
    expect(values.payoutAddress).toBe("0xabc");
  });
});

describe("AgentForm", () => {
  it("submits the converted input when the form is filled and submitted", () => {
    const onSubmit = vi.fn();
    render(
      <AgentForm
        initialValues={emptyAgentFormValues()}
        submitLabel="发布"
        pending={false}
        errorMessage={undefined}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "My Agent" } });
    fireEvent.change(screen.getByLabelText("介绍"), { target: { value: "desc" } });
    fireEvent.change(screen.getByLabelText("分类"), { target: { value: "writing" } });
    fireEvent.change(screen.getByLabelText("收款地址"), {
      target: { value: "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "发布" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "My Agent",
        description: "desc",
        category: "writing",
        payoutAddress: "0x4283fefc63f0cd0e873a0000c6d07ef7b77e90d3",
      }),
    );
  });

  it("shows the error message and disables the submit button while pending", () => {
    render(
      <AgentForm
        initialValues={emptyAgentFormValues()}
        submitLabel="发布"
        pending={true}
        errorMessage="创建失败"
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe("创建失败");
    const submitButton = screen.getByRole("button", { name: "提交中…" }) as HTMLButtonElement;
    expect(submitButton.disabled).toBe(true);
  });
});
