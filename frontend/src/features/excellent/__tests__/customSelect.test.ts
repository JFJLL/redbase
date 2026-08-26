import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import CustomSelect from "../components/CustomSelect.vue";

describe("CustomSelect", () => {
  it("deduplicates options with the same value and keeps the first label", async () => {
    const wrapper = mount(CustomSelect, {
      props: {
        modelValue: "all",
        label: "内容来源",
        options: [
          { value: "all", label: "全部来源" },
          { value: "all", label: "全部" },
          { value: "blogger", label: "博主合作笔记" },
        ],
      },
    });

    await wrapper.get(".custom-select-trigger").trigger("click");

    const options = wrapper.findAll(".custom-select-option");
    expect(options).toHaveLength(2);
    expect(options.map((option) => option.text())).toEqual(["全部来源", "博主合作笔记"]);
    expect(wrapper.findAll(".custom-select-option.is-selected")).toHaveLength(1);

    wrapper.unmount();
  });

  it("closes the previous menu when another select is opened", async () => {
    const wrapper = mount(
      {
        components: { CustomSelect },
        template: `
          <div>
            <CustomSelect model-value="all" label="视频类型" :options="['all', '星图视频']" />
            <CustomSelect model-value="all" label="内容类型" :options="['all', '美食']" />
          </div>
        `,
      },
      { attachTo: document.body },
    );

    const triggers = wrapper.findAll(".custom-select-trigger");
    await triggers[0]!.trigger("click");
    expect(wrapper.findAll(".custom-select-field.is-open")).toHaveLength(1);

    await triggers[1]!.trigger("click");
    const fields = wrapper.findAll(".custom-select-field");
    expect(fields[0]!.classes()).not.toContain("is-open");
    expect(fields[1]!.classes()).toContain("is-open");
    expect(wrapper.findAll(".custom-select-dropdown")).toHaveLength(1);

    wrapper.unmount();
  });
});
