import "./styles.css";

const project = {
  "sourceNo": 7,
  "id": "hxyfront-62005",
  "port": 62005,
  "title": "管风琴音管调音记录",
  "domain": "管风琴维护",
  "prompt": "做一个给管风琴维护人员使用的音管调音记录前端项目，可以记录教堂或音乐厅名称、音栓、音管编号、音高、音分偏差、温湿度、簧片状态和维修备注。页面需要有音栓列表、调音偏差表、温湿度记录、异常音管标记和单次维护报告页。",
  "palette": [
    "#854d0e",
    "#475569",
    "#0ea5e9"
  ],
  "metrics": [
    "音栓数量",
    "偏差超限",
    "温度",
    "湿度"
  ],
  "filters": [
    "主音栓",
    "簧片音栓",
    "混合音栓",
    "低音管"
  ],
  "fields": [
    "场馆名称",
    "音栓",
    "音管编号",
    "音高",
    "音分偏差",
    "维修备注"
  ],
  "records": [
    [
      "St.Mary",
      "Trumpet 8'",
      "C#4 +9cent",
      "簧片需微调"
    ],
    [
      "ConcertHall A",
      "Principal 4'",
      "G3 -3cent",
      "正常"
    ],
    [
      "Abbey Room",
      "Bourdon 16'",
      "F2 -12cent",
      "标记复检"
    ]
  ]
};

function App() {
  return (
    <main className="app">
      <section className="hero">
        <p>{project.id} · 源提示词{project.sourceNo} · Port {project.port}</p>
        <h1>{project.title}</h1>
        <span>{project.prompt}</span>
      </section>

      <section className="metrics">
        {project.metrics.map((metric: string, index: number) => (
          <article key={metric}>
            <small>{metric}</small>
            <strong>{[86, 14, 7, 32][index] ?? 12}</strong>
          </article>
        ))}
      </section>

      <section className="workspace">
        <aside className="panel">
          <h2>{project.domain}筛选</h2>
          <div className="chips">
            {project.filters.map((item: string) => (
              <button key={item}>{item}</button>
            ))}
          </div>
        </aside>

        <section className="panel form-panel">
          <div className="heading">
            <div>
              <p>专业字段</p>
              <h2>新增记录</h2>
            </div>
            <button className="primary">保存草稿</button>
          </div>
          <div className="field-grid">
            {project.fields.map((field: string) => (
              <label key={field}>
                <span>{field}</span>
                <input placeholder={"填写" + field} />
              </label>
            ))}
          </div>
        </section>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>历史记录</p>
            <h2>近期工作台</h2>
          </div>
          <button>导出摘要</button>
        </div>
        <div className="records">
          {project.records.map((record: string[], index: number) => (
            <article key={record.join("-")}>
              <b>{String(index + 1).padStart(2, "0")}</b>
              <div>
                <h3>{record[0]}</h3>
                <p>{record.slice(1).join(" · ")}</p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

export default App;
