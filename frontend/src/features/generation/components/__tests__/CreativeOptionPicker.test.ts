import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import CreativeOptionPicker from "../CreativeOptionPicker.vue";
import { XHS_CREATIVE_STYLE_OPTIONS } from "../../api";

describe("CreativeOptionPicker", () => {
  it("renders semantic fieldset with title, hint, and all options directly inline", () => {
    const wrapper = mount(CreativeOptionPicker, {
      props: {
        title: "小红书组图视觉",
        hint: "仅影响「一键小红书组图」",
        name: "test-xhs-style",
        value: "auto",
        options: XHS_CREATIVE_STYLE_OPTIONS,
        testId: "picker-test",
      },
    });

    const fieldset = wrapper.find("fieldset");
    expect(fieldset.exists()).toBe(true);
    expect(wrapper.find("legend").text()).toContain("小红书组图视觉");
    expect(wrapper.find("legend").text()).toContain("仅影响「一键小红书组图」");

    const optionCards = wrapper.findAll(".picker-option-card");
    expect(optionCards.length).toBe(XHS_CREATIVE_STYLE_OPTIONS.length);
    expect(wrapper.text()).toContain("智能匹配");
    expect(wrapper.text()).toContain("杂志编辑感");

    expect(wrapper.find(".picker-change-btn").exists()).toBe(false);
    expect(wrapper.find(".picker-modal-backdrop").exists()).toBe(false);
    expect(wrapper.find(".picker-modal-content").exists()).toBe(false);
  });

  it("renders accessible radio inputs with no tabindex='-1' and correct checked state", () => {
    const wrapper = mount(CreativeOptionPicker, {
      props: {
        title: "小红书组图视觉",
        name: "test-xhs-style",
        value: "editorial",
        options: XHS_CREATIVE_STYLE_OPTIONS,
        testId: "picker-test",
      },
    });

    const radioInputs = wrapper.findAll('input[type="radio"]');
    expect(radioInputs.length).toBe(XHS_CREATIVE_STYLE_OPTIONS.length);

    radioInputs.forEach((input) => {
      expect(input.attributes("tabindex")).toBeUndefined();
      expect(input.attributes("name")).toBe("test-xhs-style");
    });

    const editorialInput = wrapper.find('[data-test="picker-test-option-editorial"] input').element as HTMLInputElement;
    expect(editorialInput.checked).toBe(true);

    const autoInput = wrapper.find('[data-test="picker-test-option-auto"] input').element as HTMLInputElement;
    expect(autoInput.checked).toBe(false);
  });

  it("selects an option on click and emits update:value immediately", async () => {
    const wrapper = mount(CreativeOptionPicker, {
      props: {
        title: "小红书组图视觉",
        name: "test-xhs-style",
        value: "auto",
        options: XHS_CREATIVE_STYLE_OPTIONS,
        testId: "picker-test",
      },
    });

    await wrapper.find('[data-test="picker-test-option-editorial"] input').setValue(true);
    expect(wrapper.emitted("update:value")).toEqual([["editorial"]]);
  });

  it("displays the description of the currently selected option", () => {
    const wrapper = mount(CreativeOptionPicker, {
      props: {
        title: "小红书组图视觉",
        name: "test-xhs-style",
        value: "editorial",
        options: XHS_CREATIVE_STYLE_OPTIONS,
        testId: "picker-test",
      },
    });

    const desc = wrapper.find('[data-test="picker-test-desc"]');
    expect(desc.exists()).toBe(true);
    expect(desc.text()).toContain("克制高级，适合审美与品牌内容");
  });
});
