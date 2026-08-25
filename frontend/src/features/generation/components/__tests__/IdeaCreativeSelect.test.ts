import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import IdeaCreativeSelect from "../IdeaCreativeSelect.vue";
import { XHS_CREATIVE_STYLE_OPTIONS } from "../../api";

describe("IdeaCreativeSelect", () => {
  it("keeps options collapsed by default and shows the selected label", () => {
    const wrapper = mount(IdeaCreativeSelect, {
      props: {
        label: "小红书视觉路线",
        modelValue: "auto",
        options: XHS_CREATIVE_STYLE_OPTIONS,
        testId: "creative-style",
      },
    });

    expect(wrapper.text()).toContain("智能匹配");
    expect(wrapper.find('[data-test="creative-style-menu"]').exists()).toBe(false);
    expect(wrapper.find('[data-direction="down"]').exists()).toBe(true);
    expect(wrapper.find("select").exists()).toBe(false);
  });

  it("opens a branded menu and emits the selected value", async () => {
    const wrapper = mount(IdeaCreativeSelect, {
      props: {
        label: "小红书视觉路线",
        modelValue: "auto",
        options: XHS_CREATIVE_STYLE_OPTIONS,
        testId: "creative-style",
      },
    });

    await wrapper.find('[data-test="creative-style"]').trigger("click");
    expect(wrapper.find('[data-test="creative-style-menu"]').exists()).toBe(true);
    expect(wrapper.find('[data-direction="up"]').exists()).toBe(true);

    await wrapper.find('[data-test="creative-style-option-editorial"]').trigger("click");
    expect(wrapper.emitted("update:modelValue")).toEqual([["editorial"]]);
    expect(wrapper.find('[data-test="creative-style-menu"]').exists()).toBe(false);
    expect(wrapper.find('[data-direction="down"]').exists()).toBe(true);
  });

  it("closes with Escape and restores focus to the trigger", async () => {
    const wrapper = mount(IdeaCreativeSelect, {
      attachTo: document.body,
      props: {
        label: "小红书视觉路线",
        modelValue: "auto",
        options: XHS_CREATIVE_STYLE_OPTIONS,
        testId: "creative-style",
      },
    });

    await wrapper.find('[data-test="creative-style"]').trigger("click");
    await wrapper.find('[data-test="creative-style-menu"]').trigger("keydown", { key: "Escape" });
    await Promise.resolve();

    expect(wrapper.find('[data-test="creative-style-menu"]').exists()).toBe(false);
    expect(document.activeElement).toBe(wrapper.find('[data-test="creative-style"]').element);
    wrapper.unmount();
  });
});
