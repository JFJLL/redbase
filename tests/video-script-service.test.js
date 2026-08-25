const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  STRUCTURED_FIELD_MAX_LENGTH,
  buildSystemPrompt,
  validateAndNormalizeVideoScript,
} = require("../src/server/ai/video-script-service");

function createRawScript(overrides = {}) {
  const { clips: clipOverrides = [], ...scriptOverrides } = overrides;
  const baseClips = [
    {
      durationSec: 5,
      purpose: "开场吸睛",
      subjectReference: "主体参考：28岁都市职场女性，身穿米白色丝质西装，手持桂花茶饮。",
      firstFrame: "首帧：办公桌边的产品与人物手部特写。",
      lastFrame: "尾帧：人物扣紧茶饮杯身，杯壁水珠清晰可见。",
      scene: "场景：CBD高层办公室，窗外下午阳光形成轮廓光。",
      subjectAction: "动作：人物轻轻揉太阳穴后拿起茶饮。",
      cameraMovement: "运镜：从杯壁水珠微距开始，平滑推近至人物表情。",
      environmentMotion: "环境动态：窗外光影缓慢移动，空气微粒浮动。",
      lightingAndStyle: "光影风格：高端商业广告质感，暖金色轮廓光与通透材质。",
      audioPrompt: "声音设计：低沉大提琴单音，伴随时钟滴答与杯中冰块轻响。",
      voiceover: "旁白：下午三点，困倦与高糖的虚假满足，真的能续命吗？",
      dialogue: "人物对话：今天也要给自己一点轻盈的能量。",
      onScreenText: "画面文字：下午3点，你也这样？",
      transition: "转场：以杯身金色反光进行匹配剪辑进入下一镜。",
      continuity: "连续性：保持米白色西装、发型、茶饮包装和窗边光线方向一致。",
      referenceAssets: [
        { kind: "product", label: "产品图1", description: "正面包装、瓶型、材质和颜色" },
        { kind: "style", label: "风格图1", description: "暖金色调、通透材质与简洁构图" },
        { kind: "logo", label: "品牌Logo", description: "片尾右下角品牌标识" },
      ],
      prompt: "一个女人在办公室喝饮料。",
    },
    {
      durationSec: 25,
      purpose: "产品收束",
      subjectReference: "主体参考：同一位女性与同一杯茶饮。",
      scene: "场景：同一办公室的窗边区域。",
      subjectAction: "动作：人物微笑举起茶饮。",
      cameraMovement: "运镜：缓慢后拉展示办公室与窗景。",
      prompt: "旧提示词不应被使用。",
    },
  ];

  return {
    title: "下午三点的轻盈能量",
    creativeConcept: "办公室下午茶饮广告",
    totalDurationSec: 30,
    aspectRatio: "9:16",
    globalSubjectReference: "全片主体一致性：人物五官、米白色西装与桂花茶饮包装保持一致。",
    globalStyleReference: "全片视觉风格：暖金色电影感、商业广告级通透材质。",
    globalContinuity: "全片连续性：人物站位、窗边光线方向与产品水珠状态自然衔接。",
    audioDirection: {},
    clips: baseClips.map((clip, index) => ({ ...clip, ...(clipOverrides[index] || {}) })),
    ...scriptOverrides,
  };
}

function normalize(overrides) {
  return validateAndNormalizeVideoScript(createRawScript(overrides), {
    requestedAspectRatio: "9:16",
    targetDuration: 30,
  });
}

test("完整结构化分镜会按固定顺序无损编译，且不使用模型返回的 rawClip.prompt", () => {
  const script = normalize();
  const prompt = script.clips[0].prompt;

  const expectedFragments = [
    "【视频参数】",
    "画幅比例：9:16",
    "本分镜时长：5 秒",
    "【主体参考】",
    "主体参考：28岁都市职场女性",
    "【参考素材】",
    "产品图1：正面包装、瓶型、材质和颜色",
    "严格保持参考图中的产品造型、包装结构、颜色、材质与品牌识别元素",
    "仅参考色调、光影、构图、材质和氛围，不复制风格图中的具体人物、商品或文字",
    "仅用于品牌识别与对应位置展示，保持 Logo 本身结构与比例正确",
    "【场景环境】",
    "CBD高层办公室",
    "【首帧】",
    "【主体动作】",
    "【镜头运动】",
    "【环境动态】",
    "【光影与视觉风格】",
    "【尾帧】",
    "【连续性要求】",
    "【转场】",
    "【画面文字】",
    "【旁白】",
    "【人物对话】",
    "【声音设计】",
    "【全片统一要求】",
  ];
  expectedFragments.forEach((fragment) => assert.ok(prompt.includes(fragment), `缺少：${fragment}`));

  const orderedSections = [
    "【视频参数】",
    "【主体参考】",
    "【参考素材】",
    "【场景环境】",
    "【首帧】",
    "【主体动作】",
    "【镜头运动】",
    "【环境动态】",
    "【光影与视觉风格】",
    "【尾帧】",
    "【连续性要求】",
    "【转场】",
    "【画面文字】",
    "【旁白】",
    "【人物对话】",
    "【声音设计】",
    "【全片统一要求】",
  ];
  orderedSections.reduce((previousPosition, section) => {
    const currentPosition = prompt.indexOf(section);
    assert.ok(currentPosition > previousPosition, `${section} 未按规定顺序出现`);
    return currentPosition;
  }, -1);

  assert.equal(prompt.includes("一个女人在办公室喝饮料。"), false);
});

test("rawClip.prompt 为空时仍由已规范化的结构化字段生成完整提示词", () => {
  const script = normalize({
    clips: [{ prompt: "" }, { prompt: "" }],
  });
  const prompt = script.clips[0].prompt;

  assert.ok(prompt.includes("主体参考：28岁都市职场女性"));
  assert.ok(prompt.includes("动作：人物轻轻揉太阳穴后拿起茶饮"));
  assert.ok(prompt.includes("运镜：从杯壁水珠微距开始"));
  assert.ok(prompt.includes("声音设计：低沉大提琴单音"));
});

test("空字段不会输出机械的模块标题", () => {
  const script = normalize({
    clips: [
      {
        firstFrame: "",
        lastFrame: "",
        environmentMotion: "",
        lightingAndStyle: "",
        audioPrompt: "",
        voiceover: "",
        dialogue: "",
        onScreenText: "",
        transition: "",
        continuity: "",
        referenceAssets: [],
        prompt: "",
      },
    ],
  });
  const prompt = script.clips[0].prompt;

  ["首帧", "尾帧", "环境动态", "光影与视觉风格", "声音设计", "旁白", "人物对话", "画面文字", "转场", "连续性要求", "参考素材"].forEach((title) => {
    assert.equal(prompt.includes(`【${title}】`), false, `空字段不应输出【${title}】`);
  });
  assert.ok(prompt.includes("【场景环境】"));
  assert.ok(prompt.includes("【主体动作】"));
  assert.ok(prompt.includes("【镜头运动】"));
});

test("长字段不会因旧的 2000 字符上限而截断提示词尾部", () => {
  const continuity = `连续性起始-${"甲".repeat(2200)}-连续性尾部标记`;
  const transition = `转场起始-${"乙".repeat(2200)}-转场尾部标记`;
  const voiceover = `旁白起始-${"丙".repeat(2200)}-旁白尾部标记`;
  const audioPrompt = `声音起始-${"丁".repeat(2200)}-声音尾部标记`;
  const script = normalize({
    clips: [{ continuity, transition, voiceover, audioPrompt, prompt: "简短旧提示词" }],
  });
  const prompt = script.clips[0].prompt;

  assert.ok(STRUCTURED_FIELD_MAX_LENGTH >= 8000);
  assert.ok(prompt.length > 8000);
  ["连续性尾部标记", "转场尾部标记", "旁白尾部标记", "声音尾部标记"].forEach((marker) => {
    assert.ok(prompt.includes(marker), `长字段尾部丢失：${marker}`);
  });
});

test("全局主体、风格与连续性会作为不覆盖分镜细节的补充约束进入提示词", () => {
  const script = normalize();
  const prompt = script.clips[0].prompt;

  assert.ok(prompt.includes("全片主体一致性：全片主体一致性：人物五官、米白色西装与桂花茶饮包装保持一致。"));
  assert.ok(prompt.includes("全片视觉风格：全片视觉风格：暖金色电影感、商业广告级通透材质。"));
  assert.ok(prompt.includes("全片连续性要求：全片连续性：人物站位、窗边光线方向与产品水珠状态自然衔接。"));
  assert.ok(prompt.includes("以下要求为补充约束，不覆盖上述分镜的具体描述。"));
  assert.ok(prompt.indexOf("主体参考：28岁都市职场女性") < prompt.indexOf("全片主体一致性：全片主体一致性"));
  assert.ok(prompt.indexOf("高端商业广告质感") < prompt.indexOf("全片视觉风格：全片视觉风格"));
});

test("AI 系统提示词将 prompt 标记为可留空的兼容字段", () => {
  const systemPrompt = buildSystemPrompt();
  assert.ok(systemPrompt.includes('"prompt": ""'));
  assert.ok(systemPrompt.includes("最终完整提示词由系统根据结构化字段自动编译"));
});
