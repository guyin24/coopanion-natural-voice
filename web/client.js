async function mount(ctx) {
  const zh = ctx.language === "zh";
  const text = (a, b) => (zh ? a : b);
  const label = (value) =>
    typeof value === "string" ? value : (value?.[zh ? "zh" : "en"] ?? "");
  const h = (tag, cls, content) => ctx.ui.h(tag, cls, content);
  const invoke = (method, ...args) => ctx.invoke(method, args);
  let state = await invoke("state"),
    dirty = false,
    polling = false;
  const root = h("div", "natural-voice"),
    status = h("p", "natural-voice-status");
  status.setAttribute("role", "status");
  const notice = h(
    "p",
    "natural-voice-notice",
    text(
      "朗读文本会发送到所选平台，费用由平台收取。声音为 AI 合成。",
      "Spoken text is sent to the selected provider, which may charge for usage. Voices are AI-generated.",
    ),
  );
  const form = h("form", "natural-voice-form");
  const controls = {},
    wrappers = {},
    captions = {},
    drafts = {},
    pickers = {};
  const customModes = new Set();
  let currentCatalog = null,
    catalogRequest = 0;
  const field = (name, title, type = "text") => {
    const wrap = h("label", "natural-voice-field"),
      caption = h("span", null, title),
      input = h("input");
    input.name = name;
    input.type = type;
    if (type === "checkbox") wrap.classList.add("natural-voice-check");
    wrap.append(caption, input);
    form.append(wrap);
    controls[name] = input;
    wrappers[name] = wrap;
    captions[name] = caption;
    return input;
  };
  const selectWrap = h("label", "natural-voice-field natural-voice-full");
  selectWrap.append(h("span", null, text("语音平台", "Speech provider")));
  const provider = h("select");
  provider.name = "provider";
  for (const [id, info] of Object.entries(state.providers)) {
    const option = h("option", null, label(info.label));
    option.value = id;
    provider.append(option);
  }
  provider.value = state.config.provider;
  selectWrap.append(provider);
  form.append(selectWrap);
  field(
    "workspaceId",
    text("阿里云百炼 Workspace ID", "Alibaba Cloud Workspace ID"),
  );
  wrappers.workspaceId.classList.add("natural-voice-full");
  field("region", text("服务地域", "Service region"));
  const catalogField = (name, title) => {
    const input = field(name, title),
      old = wrappers[name],
      wrap = h("div", "natural-voice-field"),
      picker = h("select");
    picker.name = name + "Choice";
    picker.setAttribute("aria-label", title);
    input.setAttribute(
      "aria-label",
      text("自定义" + title + " ID", "Custom " + title + " ID"),
    );
    input.placeholder = text("输入自定义 ID", "Enter a custom ID");
    input.required = true;
    wrap.append(captions[name], picker, input);
    old.replaceWith(wrap);
    wrappers[name] = wrap;
    pickers[name] = picker;
    return input;
  };
  catalogField("model", text("模型", "Model"));
  catalogField("voice", text("音色", "Voice"));
  const speechStyle = field(
    "speechInstruction",
    text(
      "说话风格（留空使用模型默认语气）",
      "Speaking style (empty = model default)",
    ),
  );
  speechStyle.maxLength = 500;
  wrappers.speechInstruction.classList.add("natural-voice-full");
  speechStyle.placeholder = text(
    "例如：自然聊天；温柔安慰；开心但不夸张。",
    "For example: warm, natural conversation with subtle emotion.",
  );
  const styleHint = h(
    "small",
    null,
    text(
      "仅用于 Qwen Audio 3.0/3.1；描述语气、情感和停顿，不会作为正文朗读。",
      "For Qwen Audio 3.0/3.1 only. Describe delivery and emotion; this is not spoken text.",
    ),
  );
  wrappers.speechInstruction.append(styleHint);
  field(
    "modelTone",
    text("自动跟随回复语气", "Follow the reply’s delivery automatically"),
    "checkbox",
  );
  wrappers.modelTone.classList.add("natural-voice-full");
  const modelToneHint = h(
    "small",
    "natural-voice-full",
    text(
      "表情跟随不增加模型输出；简短标注会增加少量生成时间，单独调用时还可能多等一轮。没有语气时使用全局风格。切换模式后，按宿主提示重载系统前缀，或重启 Coopanion。",
      "Expression following adds no model output. Detailed annotation adds output and may add a model round. Global style remains the fallback. After switching modes, reload the system prefix when prompted by the host, or restart Coopanion.",
    ),
  );
  form.append(modelToneHint);
  const toneWrap = h("label", "natural-voice-field natural-voice-full"),
    toneSource = h("select");
  toneWrap.append(h("span", null, text("语气来源", "Tone source")));
  toneSource.name = "toneMode";
  for (const [value, zhLabel, enLabel] of [
    ["mood", "跟随已有表情（更快）", "Existing expression (faster)"],
    [
      "ordinal",
      "模型简短标注（更细）",
      "Brief model annotation (more detailed)",
    ],
  ]) {
    const option = h("option", null, text(zhLabel, enLabel));
    option.value = value;
    toneSource.append(option);
  }
  toneWrap.append(toneSource);
  form.append(toneWrap);
  controls.toneMode = toneSource;
  wrappers.toneMode = toneWrap;
  const showSpeechStyle = () => {
    const hidden = !(
      provider.value === "aliyun" &&
      /^qwen-audio-3\.[01]-tts-(plus|flash)$/.test(controls.model.value.trim())
    );
    wrappers.speechInstruction.hidden = hidden;
    wrappers.modelTone.hidden = hidden;
    modelToneHint.hidden = hidden;
    toneWrap.hidden = hidden;
  };
  const catalogActions = h("div", "natural-voice-catalog natural-voice-full");
  const refreshCatalog = h(
    "button",
    "btn",
    text("刷新模型和音色", "Refresh models and voices"),
  );
  refreshCatalog.type = "button";
  const catalogHint = h("small");
  catalogHint.setAttribute("role", "status");
  catalogActions.append(refreshCatalog, catalogHint);
  form.append(catalogActions);
  const speed = field(
    "speed",
    text("语速（1 为正常）", "Speed (1 = normal)"),
    "number",
  );
  speed.step = "0.01";
  speed.required = true;
  const volume = field(
    "volume",
    text(
      "音量倍率（1 为自动均衡标准音量）",
      "Volume multiplier (1 = auto-normalized)",
    ),
    "number",
  );
  volume.min = "0.25";
  volume.max = "3";
  volume.step = "0.05";
  volume.required = true;
  const sampleWrap = h("label", "natural-voice-field");
  sampleWrap.append(h("span", null, text("采样率（Hz）", "Sample rate (Hz)")));
  const sample = h("select");
  sample.name = "sampleRate";
  sampleWrap.append(sample);
  form.append(sampleWrap);
  controls.sampleRate = sample;
  const cap = field(
    "maxChars",
    text("单条最多朗读字数", "Maximum characters per reply"),
    "number",
  );
  cap.min = "50";
  cap.max = "4000";
  cap.step = "1";
  cap.required = true;
  field(
    "autoRead",
    text("自动朗读新回复", "Read new replies automatically"),
    "checkbox",
  );
  field(
    "interruptOnInput",
    text("收到新输入时停止朗读", "Stop speech on new input"),
    "checkbox",
  );
  const endpoint = field("endpoint", text("TTS 请求地址", "TTS endpoint"));
  endpoint.required = true;
  wrappers.endpoint.classList.add("natural-voice-full");
  const help = h("p", "natural-voice-help natural-voice-full");
  const docsLink = h(
    "a",
    null,
    text("平台开通与接口说明", "Provider setup and API reference"),
  );
  docsLink.target = "_blank";
  docsLink.rel = "noopener noreferrer";
  help.append(docsLink);
  form.append(help);
  const credentials = h(
    "fieldset",
    "natural-voice-credentials natural-voice-full",
  );
  const credentialInputs = {};
  const saveCredentialButton = h(
    "button",
    "btn",
    text("保存凭据并读取列表", "Save credentials and load lists"),
  );
  saveCredentialButton.type = "button";
  form.append(credentials);
  const actions = h("div", "natural-voice-actions natural-voice-full");
  const save = h("button", "btn primary", text("保存设置", "Save settings"));
  save.type = "submit";
  const clear = h(
    "button",
    "btn",
    text("清除此平台凭据", "Clear provider credentials"),
  );
  clear.type = "button";
  actions.append(save, clear);
  form.append(actions);
  const previewBox = h("div", "natural-voice-preview"),
    previewLabel = h("label", "natural-voice-field");
  previewLabel.append(h("span", null, text("试听文本", "Preview text")));
  const previewText = h("textarea");
  previewText.rows = 3;
  previewText.value = text(
    "你好呀，我现在可以用自然的声音和你说话了。",
    "Hello! I can now speak to you in a natural voice.",
  );
  previewLabel.append(previewText);
  const previewActions = h("div", "natural-voice-actions");
  const preview = h("button", "btn", text("试听", "Preview")),
    stop = h("button", "btn", text("停止朗读", "Stop speech"));
  preview.type = stop.type = "button";
  previewActions.append(preview, stop);
  const draftHint = h("small", "natural-voice-notice");
  previewBox.append(previewLabel, previewActions, status, draftHint);
  const message = h("p", "natural-voice-message");
  message.setAttribute("role", "alert");
  root.append(notice, form, previewBox, message);
  ctx.root.append(root);
  let lastProvider = provider.value;

  const ALIYUN_HTTP_TPL =
    "https://{workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer";
  const ALIYUN_WS_TPL =
    "wss://{workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference";
  const syncAliyunEndpointForModel = () => {
    if (provider.value !== "aliyun") return;
    const m = controls.model.value.trim();
    let cur = endpoint.value.trim();
    if (
      cur ===
      "wss://ws-{workspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference"
    ) {
      const id = controls.workspaceId.value.trim();
      if (id && !/^ws-/i.test(id)) controls.workspaceId.value = "ws-" + id;
      endpoint.value = cur = ALIYUN_WS_TPL;
    }
    const hasWsId = Boolean(controls.workspaceId.value.trim());
    if (
      (/^(?:qwen-audio|cosyvoice-v1|sambert)/i.test(m) ||
        (hasWsId && /^cosyvoice-v(?:2|3)/i.test(m))) &&
      cur === ALIYUN_HTTP_TPL
    ) {
      endpoint.value = ALIYUN_WS_TPL;
    } else if (
      /^cosyvoice-v(?:2|3)/i.test(m) &&
      !hasWsId &&
      cur === ALIYUN_WS_TPL
    ) {
      endpoint.value = ALIYUN_HTTP_TPL;
    }
  };

  const currentDraft = () => {
    const config = { ...state.config, provider: provider.value };
    for (const [name, input] of Object.entries(controls)) {
      config[name] =
        input.type === "checkbox"
          ? input.checked
          : ["speed", "volume", "maxChars", "sampleRate"].includes(name)
            ? Number(input.value)
            : input.value.trim();
    }
    return config;
  };
  const matchingVoices = () =>
    currentCatalog?.voices.filter(
      (voice) =>
        !(
          provider.value === "aliyun" &&
          voice.kind === "custom" &&
          !voice.models?.length
        ) &&
        (!voice.models?.length ||
          voice.models.includes(controls.model.value.trim())),
    ) ?? [];
  const fillPicker = (name, items) => {
    const picker = pickers[name],
      value = controls[name].value.trim();
    picker.replaceChildren();
    for (const item of items) {
      const option = h(
        "option",
        null,
        item.label === item.id ? item.id : item.label + " · " + item.id,
      );
      option.value = item.id;
      picker.append(option);
    }
    const custom = h(
      "option",
      null,
      text("手动输入 ID…", "Enter a custom ID…"),
    );
    custom.value = "";
    picker.append(custom);
    picker.value =
      !customModes.has(name) && items.some((item) => item.id === value)
        ? value
        : "";
    controls[name].hidden = picker.value !== "";
  };
  const renderCatalog = () => {
    showSpeechStyle();
    fillPicker("model", currentCatalog?.models ?? []);
    fillPicker("voice", matchingVoices());
    if (!currentCatalog) return;
    const source = {
      preset: text("官方预设", "Official presets"),
      mixed: text("在线目录 + 官方预设", "Live catalog + official presets"),
      live: text("在线目录", "Live catalog"),
    };
    catalogHint.textContent =
      (source[currentCatalog.source] ?? source.preset) +
      " · " +
      currentCatalog.models.length +
      text(" 个模型，", " models, ") +
      matchingVoices().length +
      text(" 个当前模型音色。", " voices for this model. ") +
      (currentCatalog.note ?? "");
    if (!matchingVoices().length)
      catalogHint.textContent += text(
        " 当前模型没有已确认的可选音色，请手动填写与模型匹配的音色 ID。",
        " No verified voices for this model; enter a compatible voice ID manually.",
      );
  };
  const catalogStamp = (cfg) => {
    const ep =
      cfg.provider === "aliyun" && cfg.endpoint === ALIYUN_WS_TPL
        ? ALIYUN_HTTP_TPL
        : cfg.endpoint;
    return JSON.stringify([cfg.provider, ep, cfg.workspaceId, cfg.region]);
  };
  const loadCatalog = async () => {
    const ticket = ++catalogRequest,
      draft = currentDraft(),
      stamp = catalogStamp(draft);
    catalogHint.textContent = text(
      "正在读取模型和音色列表…",
      "Loading models and voices…",
    );
    try {
      const result = await invoke("catalog", draft);
      if (ctx.signal.aborted || ticket !== catalogRequest) return;
      if (stamp !== catalogStamp(currentDraft())) {
        catalogHint.textContent = text(
          "配置已修改，保存后自动刷新列表。",
          "Save your changed settings to refresh the catalog.",
        );
        return;
      }
      currentCatalog = result;
      renderCatalog();
    } catch {
      if (!ctx.signal.aborted && ticket === catalogRequest)
        catalogHint.textContent = text(
          "列表读取失败，可刷新重试或手动输入 ID。",
          "Could not load lists. Retry or enter IDs manually.",
        );
    }
  };
  pickers.model.addEventListener(
    "change",
    () => {
      if (pickers.model.value) {
        customModes.delete("model");
        controls.model.value = pickers.model.value;
      } else customModes.add("model");
      syncAliyunEndpointForModel();
      const voices = matchingVoices(),
        known = currentCatalog?.voices.some(
          (voice) => voice.id === controls.voice.value,
        );
      if (
        pickers.model.value &&
        known &&
        !voices.some((voice) => voice.id === controls.voice.value)
      ) {
        controls.voice.value = voices[0]?.id ?? "";
        if (voices.length) customModes.delete("voice");
        else customModes.add("voice");
      }
      renderCatalog();
      markDirty();
    },
    { signal: ctx.signal },
  );
  pickers.voice.addEventListener(
    "change",
    () => {
      if (pickers.voice.value) {
        customModes.delete("voice");
        controls.voice.value = pickers.voice.value;
      } else customModes.add("voice");
      controls.voice.hidden = pickers.voice.value !== "";
      markDirty();
    },
    { signal: ctx.signal },
  );
  controls.model.addEventListener(
    "input",
    () => {
      syncAliyunEndpointForModel();
      fillPicker("voice", matchingVoices());
      showSpeechStyle();
    },
    { signal: ctx.signal },
  );
  refreshCatalog.addEventListener(
    "click",
    () => {
      void loadCatalog();
    },
    { signal: ctx.signal },
  );
  const fill = (values) => {
    const info = state.providers[provider.value];
    sample.replaceChildren();
    for (const rate of info.sampleRates) {
      const option = h("option", null, String(rate));
      option.value = String(rate);
      sample.append(option);
    }
    for (const [name, input] of Object.entries(controls)) {
      if (!(name in values)) continue;
      if (input.type === "checkbox") input.checked = Boolean(values[name]);
      else input.value = String(values[name]);
    }
    speed.min = String(info.speedMin);
    speed.max = String(info.speedMax);
    sampleWrap.hidden = info.showSampleRate === false;
    wrappers.workspaceId.hidden = provider.value !== "aliyun";
    wrappers.region.hidden = !["azure", "tencent"].includes(provider.value);
    wrappers.model.hidden = info.showModel === false;
    captions.model.textContent =
      label(info.modelLabel) || text("模型", "Model");
    docsLink.hidden = !info.docs;
    if (info.docs) docsLink.href = info.docs;
    controls.workspaceId.required =
      provider.value === "aliyun" && endpoint.value.includes("{workspaceId}");
    controls.region.required =
      provider.value === "azure" && endpoint.value.includes("{region}");
    showSpeechStyle();
  };
  const credentialHints = () => {
    const saved = state.credentialStatus[provider.value] ?? {};
    for (const [id, input] of Object.entries(credentialInputs)) {
      const definition = state.providers[provider.value].credentials.find(
        (field) => field.id === id,
      );
      input.required = Boolean(definition.required && !saved[id]);
      input.placeholder = saved[id]
        ? text("已保存；留空保留", "Saved; leave blank to keep")
        : text("尚未填写", "Not configured");
    }
  };
  const rebuildCredentials = () => {
    credentials.replaceChildren(
      h(
        "legend",
        null,
        text(
          "平台凭据（仅保存到本机）",
          "Provider credentials (stored locally)",
        ),
      ),
    );
    for (const key of Object.keys(credentialInputs))
      delete credentialInputs[key];
    for (const definition of state.providers[provider.value].credentials) {
      const wrap = h("label", "natural-voice-field"),
        input = h("input");
      input.type = definition.id === "appId" ? "text" : "password";
      input.name = definition.id;
      input.autocomplete = "off";
      input.spellcheck = false;
      wrap.append(
        h("span", null, label(definition.label) || definition.id),
        input,
      );
      credentials.append(wrap);
      credentialInputs[definition.id] = input;
    }
    credentials.append(
      h(
        "small",
        "natural-voice-notice natural-voice-full",
        text(
          "每个平台单独保存凭据；切换平台会清空尚未保存的凭据输入。",
          "Credentials are saved separately per provider. Switching clears unsaved credential inputs.",
        ),
      ),
    );
    credentials.append(
      saveCredentialButton,
      h(
        "small",
        "natural-voice-notice natural-voice-full",
        text(
          "可先保存凭据读取列表，再选择模型和音色；平台地址及其他设置最后统一保存。",
          "Save credentials to load lists before choosing a model and voice, then save all settings.",
        ),
      ),
    );
    credentialHints();
  };
  const renderStatus = (next) => {
    state = next;
    const phases = {
      offline: text("未启用", "Disabled"),
      idle: text("等待回复", "Waiting for replies"),
      generating: text("生成语音中", "Generating audio"),
      playing: text("正在朗读", "Speaking"),
      error: text("发生错误", "Error"),
    };
    const activeLabel = label(next.providers[next.config.provider].label);
    status.textContent = !next.running
      ? text("请先启用此 World。", "Enable this World first.")
      : activeLabel +
        " · " +
        (!next.keySet
          ? text("请保存此平台凭据", "Save provider credentials")
          : (phases[next.phase] ?? next.phase)) +
        (next.queued
          ? text(
              " · 等待 " + next.queued + " 条",
              " · " + next.queued + " queued",
            )
          : "") +
        (next.error ? "：" + next.error : "");
    if (next.phase === "playing" && next.lastTone)
      status.textContent +=
        text(" · 本句语气：", " · Delivery: ") + next.lastTone;
    if (next.sync?.mode === "degraded")
      status.textContent += text(
        " · 文字直接显示",
        " · Text is shown immediately",
      );
    preview.disabled = dirty || !next.running || !next.keySet;
    stop.disabled = !next.busy && !next.queued;
    draftHint.textContent = dirty
      ? text(
          "有未保存的修改，请先保存再试听。",
          "Save your changes before previewing.",
        )
      : "";
    credentialHints();
  };
  const markDirty = () => {
    dirty = true;
    message.textContent = "";
    renderStatus(state);
  };
  const act = async (fn) => {
    message.textContent = "";
    try {
      await fn();
    } catch (error) {
      if (!ctx.signal.aborted) message.textContent = error.message;
    }
  };
  saveCredentialButton.addEventListener(
    "click",
    () => {
      void act(async () => {
        const selectedProvider = provider.value,
          inputs = Object.values(credentialInputs);
        const values = Object.fromEntries(
          Object.entries(credentialInputs)
            .filter(([, input]) => input.value.trim() !== "")
            .map(([id, input]) => [id, input.value.trim()]),
        );
        const fields = [...form.querySelectorAll("input,select,button")];
        for (const field of fields) field.disabled = true;
        try {
          const next = await invoke(
            "saveCredentials",
            selectedProvider,
            values,
          );
          if (ctx.signal.aborted) return;
          for (const input of inputs) input.value = "";
          renderStatus(next);
          message.textContent = text(
            "凭据已保存，正在读取列表；选择完成后请保存设置。",
            "Credentials saved. Loading lists; save settings after choosing.",
          );
        } finally {
          for (const field of fields) field.disabled = false;
        }
        if (!ctx.signal.aborted) await loadCatalog();
      });
    },
    { signal: ctx.signal },
  );
  provider.addEventListener(
    "change",
    () => {
      drafts[lastProvider] = { ...currentDraft(), provider: lastProvider };
      fill({
        ...currentDraft(),
        ...state.presets[provider.value],
        ...drafts[provider.value],
        provider: provider.value,
      });
      lastProvider = provider.value;
      customModes.clear();
      currentCatalog = null;
      renderCatalog();
      rebuildCredentials();
      markDirty();
      void loadCatalog();
    },
    { signal: ctx.signal },
  );
  form.addEventListener(
    "input",
    (event) => {
      if (event.target !== provider) markDirty();
    },
    { signal: ctx.signal },
  );
  form.addEventListener(
    "change",
    (event) => {
      if (event.target !== provider) markDirty();
    },
    { signal: ctx.signal },
  );
  form.addEventListener(
    "submit",
    (event) => {
      event.preventDefault();
      void act(async () => {
        const draft = currentDraft(),
          selectedProvider = draft.provider;
        const values = Object.fromEntries(
          Object.entries(credentialInputs)
            .filter(([, input]) => input.value.trim() !== "")
            .map(([id, input]) => [id, input.value.trim()]),
        );
        const editingFields = [...form.querySelectorAll("input,select,button")];
        for (const field of editingFields) field.disabled = true;
        try {
          await invoke("validateConfig", draft);
          await invoke("stop");
          await invoke("saveCredentials", selectedProvider, values);
          for (const input of Object.values(credentialInputs)) input.value = "";
          const names = ["provider", ...Object.keys(controls)];
          await ctx.setConfig(
            "world:natural-voice",
            Object.fromEntries(
              names.map((name) => [
                "worlds.natural-voice." + name,
                draft[name],
              ]),
            ),
          );
          dirty = false;
          drafts[selectedProvider] = draft;
          renderStatus(await invoke("state"));
          message.textContent = text("设置已保存。", "Settings saved.");
          await ctx.refresh();
          if (!ctx.signal.aborted) void loadCatalog();
        } finally {
          for (const field of editingFields) field.disabled = false;
        }
      });
    },
    { signal: ctx.signal },
  );
  clear.addEventListener(
    "click",
    () => {
      void act(async () => {
        const selectedProvider = provider.value,
          inputs = Object.values(credentialInputs);
        const fields = [...form.querySelectorAll("input,select,button")];
        for (const field of fields) field.disabled = true;
        try {
          const next = await invoke("clearCredentials", selectedProvider);
          if (ctx.signal.aborted) return;
          renderStatus(next);
          for (const input of inputs) input.value = "";
          message.textContent = text(
            "此平台的凭据已清除。",
            "Provider credentials cleared.",
          );
          void loadCatalog();
        } finally {
          for (const field of fields) field.disabled = false;
        }
      });
    },
    { signal: ctx.signal },
  );
  preview.addEventListener(
    "click",
    () => {
      void act(async () =>
        renderStatus(await invoke("preview", previewText.value)),
      );
    },
    { signal: ctx.signal },
  );
  stop.addEventListener(
    "click",
    () => {
      void act(async () => renderStatus(await invoke("stop")));
    },
    { signal: ctx.signal },
  );
  fill(state.config);
  rebuildCredentials();
  renderStatus(state);
  renderCatalog();
  void loadCatalog();
  ctx.interval(() => {
    if (polling) return;
    polling = true;
    void invoke("state")
      .then(
        (next) => {
          if (!ctx.signal.aborted) renderStatus(next);
        },
        (error) => {
          if (!ctx.signal.aborted) status.textContent = error.message;
        },
      )
      .finally(() => {
        polling = false;
      });
  }, 1000);
}
export default { panels: { voice: { mount } } };
