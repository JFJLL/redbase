// Landing page markup, migrated 1:1 from public/index.html (logged-out page).
// data-auth-open restores the legacy in-page modal while keeping the Vue
// landing page markup aligned with the original public/index.html.
// Above-the-fold images declare width/height + eager/high priority; everything
// below the fold lazy-loads. No external font/script requests are allowed here.

export const LANDING_HTML = `
    <header class="site-nav">
      <div class="container nav-inner" id="landingNavInner">
        <a class="landing-logo" href="#top" aria-label="RedBase 首页">
          <span class="landing-logo-image">
            <img src="/assets/redbase-logo.png" alt="" width="36" height="36" loading="eager" fetchpriority="high" />
          </span>
          <span>RedBase</span>
        </a>
        <nav class="nav-links" aria-label="主导航">
          <a href="#problems">为什么需要</a>
          <a href="#workspace">产品能力</a>
          <a href="#workflow">工作流程</a>
          <a href="#outputs">输出成果</a>
          <a href="#pricing">企业服务</a>
          <a href="#faq">常见问题</a>
          <a href="/app/">进入工作台</a>
        </nav>
        <div class="nav-actions">
          <button class="landing-btn nav-login" data-auth-open="login" type="button">登录</button>
          <button class="landing-btn landing-btn-primary" data-auth-open="register" type="button">免费使用</button>
          <button class="menu-btn" id="landingMenuButton" type="button" aria-label="展开导航" aria-expanded="false">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>
        </div>
      </div>
    </header>

    <main id="top">
      <section class="commercial-hero">
        <div class="container hero-grid">
          <div class="hero-copy landing-reveal">
            <div class="commercial-badge"><span class="pulse"></span>品牌内容决策与生产工作台</div>
            <h1>让品牌每天都知道<br /><span>什么内容值得做</span></h1>
            <p class="hero-lead">
              RedBase 将品牌档案、个人 IP、趋势证据、优秀内容、内容选题与 AI
              图文生产放进同一套工作流，帮助团队更顺畅地完成机会发现、方向判断和内容生成。
            </p>
            <div class="hero-cta">
              <button class="landing-btn landing-btn-primary landing-btn-lg" data-auth-open="register" type="button">免费创建品牌档案</button>
              <a class="landing-btn landing-btn-outline landing-btn-lg" href="#workspace">查看产品演示 ↓</a>
            </div>
            <div class="hero-note"><i></i>外部用户使用手机号注册；飞书登录仅限公司内部账号</div>
            <div class="hero-chain">
              <div><b>01</b>发现内容机会</div>
              <div><b>02</b>确定执行方向</div>
              <div><b>03</b>生成图文资产</div>
              <div><b>04</b>沉淀历史内容</div>
            </div>
          </div>

          <div class="product-stage landing-reveal" aria-label="RedBase 产品能力示例">
            <div class="float-chip float-chip-top"><span>趋</span><div><b>8 个高匹配方向</b><small>趋势与品牌共同判断</small></div></div>
            <div class="mock-window">
              <div class="mock-bar"><i></i><i></i><i></i><span><b>RedBase</b> · 产品示例界面</span></div>
              <div class="mock-body">
                <aside class="mock-side">
                  <div class="mock-logo">
                    <span class="landing-logo-image mini"><img src="/assets/redbase-logo.png" alt="" width="27" height="27" loading="eager" fetchpriority="high" /></span>
                    <span>RedBase</span>
                  </div>
                  <div class="mock-nav" role="tablist" aria-label="产品示例">
                    <button class="active" data-hero-tab="trend" type="button" role="tab" aria-selected="true">趋势分析</button>
                    <button data-hero-tab="excellent" type="button" role="tab" aria-selected="false">优秀内容</button>
                    <button data-hero-tab="idea" type="button" role="tab" aria-selected="false">内容选题</button>
                    <button data-hero-tab="generate" type="button" role="tab" aria-selected="false">内容生成</button>
                  </div>
                </aside>
                <div class="mock-main">
                  <div class="mock-head">
                    <div><h3 id="heroPanelTitle">值得跟进的内容机会</h3><p id="heroPanelSub">从趋势信号中筛选与品牌真正相关的方向</p></div>
                    <span>示例结果</span>
                  </div>
                  <div class="hero-panel active" data-hero-panel="trend">
                    <div class="signal-summary">
                      <div><small>趋势候选</small><b>24</b></div>
                      <div><small>高匹配方向</small><b>8</b></div>
                      <div><small>证据更新时间</small><b>今天</b></div>
                    </div>
                    <div class="signal-list">
                      <div class="signal-row"><i>01</i><div><strong>真实体验型内容持续增长</strong><small>用户更关注过程、细节证据与实际变化</small></div><span>匹配 92</span></div>
                      <div class="signal-row"><i>02</i><div><strong>“替我做选择”型内容受欢迎</strong><small>榜单、横测与清单进入用户决策链路</small></div><span>匹配 88</span></div>
                      <div class="signal-row"><i>03</i><div><strong>生活方式场景替代硬卖点</strong><small>品牌价值需要进入真实生活语境</small></div><span>匹配 84</span></div>
                    </div>
                  </div>
                  <div class="hero-panel" data-hero-panel="excellent">
                    <div class="excellent-grid">
                      <article><img src="/assets/landing-excellent-source-01.webp" alt="产品使用过程与体验记录示例" loading="lazy" /><b>结构拆解</b><small>热门内容示例</small></article>
                      <article><img src="/assets/landing-excellent-source-02.webp" alt="产品对比与决策清单示例" loading="lazy" /><b>表达学习</b><small>电商内容示例</small></article>
                      <article><img src="/assets/landing-excellent-source-03.webp" alt="产品融入真实生活场景示例" loading="lazy" /><b>场景切口</b><small>支持一键仿图文</small></article>
                    </div>
                  </div>
                  <div class="hero-panel" data-hero-panel="idea">
                    <div class="idea-list">
                      <article><small>方向 01 · 选择决策</small><b>把复杂卖点转化成用户一眼能判断的选择标准</b><p>目标人群：比较阶段用户｜形式：横测清单 + 场景判断</p></article>
                      <article><small>方向 02 · 价值证明</small><b>用真实体验讲清产品为什么值得</b><p>目标人群：价格犹豫用户｜形式：细节证据 + 前后对比</p></article>
                      <article><small>方向 03 · 生活方式</small><b>把产品价值放进真实生活场景</b><p>目标人群：对广告敏感用户｜形式：一天使用记录</p></article>
                    </div>
                  </div>
                  <div class="hero-panel" data-hero-panel="generate">
                    <div class="generation-preview">
                      <div class="generation-brief"><b>内容目标</b><p>建立价格价值感，并降低用户选择难度。</p></div>
                      <div class="generation-pages">
                        <img src="/assets/landing-generated-xhs-01.webp" alt="小红书组图选择理由页" loading="lazy" />
                        <img src="/assets/landing-generated-xhs-02.webp" alt="小红书组图用户问题页" loading="lazy" />
                        <img src="/assets/landing-generated-xhs-03.webp" alt="小红书组图价值证明页" loading="lazy" />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div class="float-chip float-chip-bottom"><span>图</span><div><b>已生成 3 页组图</b><small>进入历史生成资产</small></div></div>
          </div>
        </div>
      </section>

      <section class="capability-rail" aria-label="完整产品能力">
        <div class="rail-label">当前 RedBase 已形成的完整产品能力</div>
        <div class="rail-track">
          <div><b>品</b>品牌档案</div><div><b>人</b>个人 IP</div><div><b>趋</b>趋势分析</div><div><b>选</b>内容选题</div>
          <div><b>优</b>优秀内容</div><div><b>图</b>多类型图文生成</div><div><b>历</b>历史生成</div>
          <div aria-hidden="true"><b>品</b>品牌档案</div><div aria-hidden="true"><b>人</b>个人 IP</div><div aria-hidden="true"><b>趋</b>趋势分析</div>
          <div aria-hidden="true"><b>选</b>内容选题</div><div aria-hidden="true"><b>优</b>优秀内容</div><div aria-hidden="true"><b>图</b>多类型图文生成</div>
        </div>
      </section>

      <section class="commercial-section white" id="problems">
        <div class="container">
          <div class="commercial-section-head center landing-reveal">
            <span class="eyebrow">Why RedBase</span>
            <h2>内容团队需要一套连贯的内容工作流</h2>
            <p>影响效率的关键，在于品牌资料、趋势判断和内容生产长期分散在不同环节。</p>
          </div>
          <div class="problem-grid landing-reveal">
            <article><span>01</span><h3>资料是散的</h3><p>品牌定位、产品卖点、目标人群和历史内容分散在不同文档里，每次使用 AI 都要重新解释。</p></article>
            <article><span>02</span><h3>判断是慢的</h3><p>热点、优秀内容和竞品方向需要人工反复寻找，团队很难快速确定“这周到底做什么”。</p></article>
            <article><span>03</span><h3>生产是断的</h3><p>洞察、选题、文案和图片分别在不同工具完成，信息在交接中损耗，最终内容与策略脱节。</p></article>
          </div>
        </div>
      </section>

      <section class="commercial-section" id="workspace">
        <div class="container">
          <div class="commercial-section-head center landing-reveal">
            <span class="eyebrow">Workspace</span>
            <h2>一套围绕内容决策构建的工作台</h2>
            <p>每个模块可以独立使用，组合起来则形成从发现、判断到生产和复用的完整闭环。</p>
          </div>
          <div class="capability-grid landing-reveal">
            <article class="capability-card wide">
              <span class="capability-icon">↗</span><h3>趋势分析：找到真正适合品牌的机会</h3>
              <p>从不同趋势维度和真实证据中筛选方向，同时说明热度变化和品牌跟进理由。</p>
              <div class="mini-trends">
                <div><span>真实体验内容增长</span><i><em style="--width:92%"></em></i><b>92</b></div>
                <div><span>选择指南型内容</span><i><em style="--width:88%"></em></i><b>88</b></div>
                <div><span>生活方式场景表达</span><i><em style="--width:84%"></em></i><b>84</b></div>
              </div>
            </article>
            <article class="capability-card profile-card">
              <span class="capability-icon">品</span><h3>品牌档案与个人 IP</h3>
              <p>为不同内容主体建立长期可维护的上下文，让后续任务持续复用已有信息。</p>
              <div class="profile-switch">
                <button class="active" data-profile="brand" type="button">品牌档案</button>
                <button data-profile="personal" type="button">个人 IP</button>
              </div>
              <div class="profile-preview" id="landingProfilePreview">
                <div><strong>定位</strong>高品质家庭健康品牌</div>
                <div><strong>人群</strong>家庭健康决策者</div>
                <div><strong>目标</strong>建立价格价值感</div>
              </div>
            </article>
            <article class="capability-card">
              <span class="capability-icon">优</span><h3>优秀内容</h3>
              <p>浏览小红书热门与电商热门内容，查看多图详情，并将优秀表达方式转化为原创内容方向。</p>
              <div class="card-media"><img src="/assets/landing-capability-excellent.webp" alt="优秀内容参考库界面示例" loading="lazy" /></div>
            </article>
            <article class="capability-card">
              <span class="capability-icon">选</span><h3>内容选题</h3>
              <p>把品牌资产、趋势判断和优秀内容参考，转化成目标人群、切口、标题与推荐理由。</p>
              <div class="topic-preview"><small>方向 01 · 价值证明</small><b>用真实体验讲清产品为什么值得</b><p>人群：价格犹豫用户｜形式：细节证据 + 对比</p></div>
            </article>
            <article class="capability-card">
              <span class="capability-icon">图</span><h3>多类型内容生成</h3>
              <p>从选题继续生成适合不同渠道和用途的图文内容。</p>
              <div class="format-list"><span>小红书组图<small>3:4 多页</small></span><span>朋友圈图文<small>单页</small></span><span>公众号长图<small>长版面</small></span></div>
            </article>
            <article class="capability-card history-card">
              <span class="capability-icon">历</span><h3>历史生成：让每一次产出都能继续被使用</h3>
              <p>生成结果统一进入历史记录，支持按品牌与类型查看、预览和下载，减少重复生产。</p>
              <div class="history-preview">
                <img src="/assets/landing-history-thumb-01.webp" alt="历史资产中的小红书组图" loading="lazy" /><img src="/assets/landing-history-thumb-02.webp" alt="历史资产中的产品推广图文" loading="lazy" /><img src="/assets/landing-history-thumb-03.webp" alt="历史资产中的公众号长图" loading="lazy" />
              </div>
            </article>
          </div>
        </div>
      </section>

      <section class="commercial-section white" id="workflow">
        <div class="container">
          <div class="commercial-section-head center landing-reveal">
            <span class="eyebrow">Content Workflow</span>
            <h2>把分散功能串成一条连续的内容工作链路</h2>
            <p>RedBase 把原本分散的判断与生产环节连起来，让团队每一步都知道下一步该做什么。</p>
          </div>
          <div class="workflow-step landing-reveal">
            <div class="workflow-copy"><span class="eyebrow">01 · Discover</span><h3>先判断哪个机会值得品牌跟进</h3><p>趋势热度只是起点。RedBase 会把趋势信号、讨论内容与品牌上下文放在一起，给出可解释的适配判断。</p><ul><li>不同趋势维度分别分析，避免把所有热点混在一起</li><li>每条趋势包含品牌适配理由与证据来源</li><li>可从趋势结果直接进入内容选题</li></ul></div>
            <div class="workflow-panel"><header><h4>机会判断示例</h4><span>品牌适配优先</span></header><div class="evidence-list"><div><i>趋</i><p><b>真实体验型内容持续增长</b><small>讨论热度与高阅读内容同时出现</small></p><em>高匹配</em></div><div><i>人</i><p><b>目标人群正处于选择阶段</b><small>需要清单、横测与决策标准</small></p><em>可执行</em></div><div><i>品</i><p><b>品牌具备可被证明的具体价值</b><small>适合用体验细节代替抽象卖点</small></p><em>值得做</em></div></div></div>
          </div>
          <div class="workflow-step reverse landing-reveal">
            <div class="workflow-copy"><span class="eyebrow">02 · Learn</span><h3>从优秀内容中提取可以学习的表达方式</h3><p>查看热门内容的图文结构、标题切口和视觉表达，再结合自己的品牌方向做原创融合。</p><ul><li>小红书热门与电商热门两个内容板块</li><li>支持多图详情查看与内容结构学习</li><li>支持一键仿图文与选题方向融合</li></ul></div>
            <div class="workflow-panel learning-panel"><img src="/assets/landing-learning-example.webp" alt="拆解优秀内容表达方式的学习示例" loading="lazy" /><div><h4>重点学习内容解决问题的方式</h4><p>将原内容拆成“问题切入—真实场景—证据说明—行动结论”，再替换为品牌自己的信息与素材。</p><div><span>问题型封面</span><span>真实场景</span><span>证据细节</span><span>清晰结论</span></div></div></div>
          </div>
          <div class="workflow-step landing-reveal">
            <div class="workflow-copy"><span class="eyebrow">03 · Make</span><h3>从一个内容方向，继续生成可发布、可复用的图文资产</h3><p>选题确定后，可以继续加入产品图、品牌 Logo 和风格参考，生成不同渠道的内容形式，并进入历史资产。</p><ul><li>根据内容选择视觉路线与画面比例</li><li>支持产品图、Logo 与风格参考</li><li>生成结果自动进入历史生成记录</li></ul></div>
            <div class="workflow-panel output-panel"><header><h4>小红书组图示例</h4><span>3:4 多页内容</span></header><div><img src="/assets/landing-generated-xhs-01.webp" alt="小红书组图选择理由页" loading="lazy" /><img src="/assets/landing-generated-xhs-02.webp" alt="小红书组图用户问题页" loading="lazy" /><img src="/assets/landing-generated-xhs-03.webp" alt="小红书组图价值证明页" loading="lazy" /></div></div>
          </div>
        </div>
      </section>

      <section class="commercial-section" id="compare">
        <div class="container">
          <div class="commercial-section-head center landing-reveal"><span class="eyebrow">Why Different</span><h2>RedBase 把内容判断与后续生产连接起来</h2><p>品牌上下文、机会判断和后续生产可以在同一套流程中连续衔接。</p></div>
          <div class="compare-table-wrap landing-reveal"><table><thead><tr><th>工作环节</th><th>人工分散处理</th><th>普通对话式 AI</th><th>RedBase</th></tr></thead><tbody><tr><td>品牌上下文</td><td>散落在多个文档</td><td>每次对话重新输入</td><td>品牌档案 / 个人 IP 持续维护</td></tr><tr><td>内容机会来源</td><td>人工搜集热点与案例</td><td>主要依赖提示词与模型知识</td><td>趋势证据 + 优秀内容共同判断</td></tr><tr><td>内容方向</td><td>人工整理成 Brief</td><td>输出一段通用建议</td><td>人群、切口、标题、理由结构化输出</td></tr><tr><td>后续生产</td><td>切换到其他工具继续制作</td><td>多数停留在文本阶段</td><td>选题继续生成多类型图文</td></tr><tr><td>资产复用</td><td>分散保存，难以回找</td><td>依赖历史对话</td><td>历史生成统一管理与下载</td></tr></tbody></table></div>
        </div>
      </section>

      <section class="commercial-section white" id="outputs">
        <div class="container">
          <div class="commercial-section-head center landing-reveal"><span class="eyebrow">Outputs</span><h2>从内容建议继续走到图文生产</h2><p>根据发布渠道和内容用途，生成不同尺寸与结构的图文资产。</p></div>
          <div class="outputs-grid landing-reveal">
            <article><div><img src="/assets/landing-output-xhs.webp" alt="小红书多页产品内容展示" loading="lazy" /></div><h3>小红书组图</h3><p>多页内容结构，适合观点、清单、教程和产品沟通。</p></article>
            <article><div><img src="/assets/landing-output-moments.webp" alt="朋友圈单页图文展示" loading="lazy" /></div><h3>朋友圈图文</h3><p>单页图文表达，适合私域分享与重点信息传播。</p></article>
            <article><div><img src="/assets/landing-output-longform.webp" alt="公众号长图内容展示" loading="lazy" /></div><h3>公众号长图</h3><p>长版面内容结构，适合深度文章、教程与报告。</p></article>
          </div>
        </div>
      </section>

      <section class="commercial-section" id="pricing">
        <div class="container">
          <div class="commercial-section-head center landing-reveal"><span class="eyebrow">Pricing</span><h2>按需接入你的内容工作流</h2><p>个人用户可直接手机号注册体验；企业团队可联系商务了解合作方案。</p></div>
          <div class="pricing-grid landing-reveal">
            <article><span class="price-name">单月版</span><div class="price">¥3,500<small>/ 月</small></div><p>适合需要灵活接入、按月评估使用效果的团队。</p><ul><li>每月 1000 积分</li><li>品牌档案与个人 IP</li><li>趋势分析、优秀内容与内容选题</li><li>多类型图文生成与历史记录</li></ul><button class="landing-btn landing-btn-outline" data-business-quote-open type="button">联系商务</button></article>
            <article class="featured"><span class="price-tag">年付更优惠</span><span class="price-name">包年版</span><div class="price">¥35,000<small>/ 年</small></div><p>适合希望长期使用，并建立稳定内容工作流的团队。</p><ul><li>每月 1000 积分</li><li>包含单月版全部产品能力</li><li>全年持续使用</li><li>商务合作沟通支持</li></ul><button class="landing-btn landing-btn-primary" data-business-quote-open type="button">预约产品演示</button></article>
          </div>
          <p class="pricing-note">积分到期自动刷新，不结转至下个月；具体企业合作范围以商务沟通为准。</p>
          <div class="business-strip landing-reveal"><div><b>还不确定 RedBase 是否适合你的团队？</b><span>预约一次产品演示，直接看真实工作流程和使用方式。</span></div><button class="landing-btn landing-btn-primary" data-business-quote-open type="button">预约企业演示</button></div>
        </div>
      </section>

      <section class="commercial-section white" id="faq">
        <div class="container">
          <div class="commercial-section-head center landing-reveal"><span class="eyebrow">FAQ</span><h2>常见问题</h2></div>
          <div class="faq-list landing-reveal">
            <article class="open"><button class="faq-question" type="button" aria-expanded="true">RedBase 适合哪些用户？<span>＋</span></button><div class="faq-answer"><p>适合品牌方、代理公司、内容策略与运营团队，也适合需要长期稳定输出内容的个人 IP。品牌档案和个人 IP 档案会为后续内容任务持续提供上下文。</p></div></article>
            <article><button class="faq-question" type="button" aria-expanded="false">生成的选题和图片可以继续调整吗？<span>＋</span></button><div class="faq-answer"><p>可以。选题可以通过补充提示词继续调整，图片生成前也可以选择产品图、Logo、画面比例和视觉路线；生成完成后可在历史记录中查看和下载。</p></div></article>
            <article><button class="faq-question" type="button" aria-expanded="false">为什么建议先创建品牌档案？<span>＋</span></button><div class="faq-answer"><p>品牌档案是趋势判断、内容选题和图文生成的长期上下文。建立后，后续任务会持续使用同一套品牌定位、产品与目标人群信息。</p></div></article>
            <article><button class="faq-question" type="button" aria-expanded="false">优秀内容板块可以做什么？<span>＋</span></button><div class="faq-answer"><p>可以查看小红书热门与电商热门内容、浏览多图详情，并基于优秀内容进行一键仿图文，或与现有内容选题做融合生成。</p></div></article>
            <article><button class="faq-question" type="button" aria-expanded="false">历史生成的图片保存多久？<span>＋</span></button><div class="faq-answer"><p>历史生成图片当前保存七天，请及时下载；生成记录中的标题、文案等信息仍可在历史生成中查看。</p></div></article>
          </div>
        </div>
      </section>

      <section class="commercial-cta">
        <div class="container">
          <div class="commercial-cta-panel landing-reveal"><h2>从下一次内容决策开始，延续已经沉淀的品牌信息</h2><p>先建立品牌档案，让趋势、选题和内容生产都围绕同一套品牌上下文展开。</p><button class="landing-btn landing-btn-lg" data-auth-open="register" type="button">免费注册使用</button></div>
        </div>
      </section>
    </main>

    <footer class="commercial-footer">
      <div class="container">
        <div class="footer-grid">
          <div class="footer-intro"><a class="landing-logo" href="#top"><span class="landing-logo-image"><img src="/assets/redbase-logo.png" alt="" width="36" height="36" loading="lazy" /></span><span>RedBase</span></a><p>让品牌持续知道什么内容值得做，并把它真正生产出来。</p></div>
          <div><h4>产品</h4><a href="#workspace">品牌档案</a><a href="#workspace">趋势分析</a><a href="#workspace">优秀内容</a><a href="#outputs">图文生成</a></div>
          <div><h4>服务</h4><a href="#pricing">企业服务</a><a href="#pricing">定价方案</a><a href="#faq">常见问题</a></div>
          <div><h4>账户</h4><button data-auth-open="login" type="button">手机号登录</button><button data-auth-open="register" type="button">免费注册</button><a href="/app/">进入工作台</a></div>
        </div>
        <div class="footer-bottom"><span>Copyright © 2026 RedBase</span><span>京ICP备2026045114号-1</span></div>
      </div>
    </footer>
`;

export const AUTH_MODAL_HTML = `
  <div class="modal-panel auth-modal-panel" role="dialog" aria-modal="true" aria-labelledby="authModalTitle">
    <div class="modal-head auth-modal-head">
      <div>
        <div class="modal-kicker">账户访问</div>
        <h2 id="authModalTitle">欢迎来到 RedBase</h2>
        <p>先完成手机号注册或登录，再进入你的品牌增长工作台。</p>
      </div>
      <button class="modal-close" id="closeAuthModal" type="button" aria-label="返回官网">×</button>
    </div>

    <div class="auth-shell">
      <div class="auth-brand-panel">
        <div class="logo-wrap logo-wrap-vertical auth-brand-logo">
          <div class="logo-icon logo-icon-large" aria-hidden="true">
            <img class="logo-image" src="/assets/redbase-logo.png" alt="RedBase logo" />
          </div>
          <div><div class="sidebar-subtitle">内容趋势与品牌运营系统</div></div>
        </div>
        <h3>让热点服务于品牌，而不是让品牌被热点牵着走。</h3>
        <p>注册后你就可以创建品牌档案、生成热点分析、产出内容选题，并一键获取视觉方案。</p>
      </div>

      <div class="auth-form-panel">
        <div class="feishu-login-actions" id="feishuLoginActions" hidden>
          <button class="feishu-login-btn" id="feishuLoginButton" type="button">
            <span class="feishu-login-mark">飞</span>
            <span>飞书企业登录</span>
          </button>
          <div class="feishu-app-menu" id="feishuAppMenu" hidden></div>
        </div>
        <div class="auth-divider" id="feishuAuthDivider" hidden><span>或使用手机号</span></div>

        <div class="auth-tab-row">
          <button class="auth-tab is-active" data-auth-tab="register" type="button">手机号注册</button>
          <button class="auth-tab" data-auth-tab="login" type="button">手机号登录</button>
        </div>

        <form class="auth-form auth-form-active" id="registerForm">
          <label>
            <span>手机号</span>
            <input name="phone" type="tel" placeholder="请输入手机号" autocomplete="tel" required />
          </label>
          <label>
            <span>昵称</span>
            <input name="name" placeholder="请输入你的昵称" required />
          </label>
          <label>
            <span>登录密码</span>
            <input name="password" type="password" placeholder="至少 6 位密码" autocomplete="new-password" required />
          </label>
          <p class="form-error auth-form-error" id="registerFormError" role="alert" hidden></p>
          <button class="primary-btn auth-submit-btn" type="submit">注册并进入工作台</button>
        </form>

        <form class="auth-form" id="loginForm">
          <label>
            <span>手机号</span>
            <input name="phone" type="tel" placeholder="请输入手机号" autocomplete="tel" required />
          </label>
          <label>
            <span>密码</span>
            <input name="password" type="password" placeholder="请输入登录密码" autocomplete="current-password" required />
          </label>
          <div class="auth-helper">已注册账号可直接登录。</div>
          <p class="form-error auth-form-error" id="loginFormError" role="alert" hidden></p>
          <button class="primary-btn auth-submit-btn" type="submit">登录 RedBase</button>
        </form>
      </div>
    </div>
  </div>
`;

export const BUSINESS_MODAL_HTML = `
  <div class="modal-panel business-modal-panel" role="dialog" aria-modal="true" aria-labelledby="businessQuoteTitle">
    <button class="modal-close business-modal-close" id="closeBusinessQuoteModal" type="button" aria-label="关闭报价弹窗">×</button>
    <div class="business-modal-content">
      <h2 id="businessQuoteTitle">定制专属增长方案</h2>

      <div class="business-price-grid" aria-label="RedBase 企业报价">
        <div class="business-price-item">
          <span>单月版</span>
          <strong>¥3,500</strong>
          <small>按月灵活接入</small>
          <small>每月 1000 积分</small>
        </div>
        <div class="business-price-item">
          <span>包年版</span>
          <strong>¥35,000</strong>
          <small>年付更优惠</small>
          <small>每月 1000 积分</small>
        </div>
      </div>
      <p class="business-credit-note">两个版本均为每月 1000 积分；积分到期自动刷新，不会结转至下个月。</p>

      <div class="business-qrcode-card">
        <img src="/assets/qrcode.png" alt="联系专属商务二维码" loading="lazy" />
      </div>
      <div class="business-contact-title">联系专属商务</div>
      <div class="business-contact-copy">扫码获取优惠价格</div>
    </div>
  </div>
`;
