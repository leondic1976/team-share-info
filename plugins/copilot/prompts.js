/* Prompt building for the Copilot helper (no DOM). Exposed as globalThis.CopilotPrompts; unit-tested in tests/plugins. */
;(function (g) {
  'use strict'

  /**
   * Tasks. `ask` is what Copilot is told to do, `input` the label of the text box,
   * `needsText` whether there must be material to work on, `extra` an optional second field.
   */
  const TASKS = [
    { id: 'summary', icon: 'notebook-pen', name: '요약', input: '요약할 글', needsText: true, ask: '아래 글을 핵심만 요약해 주세요. 중요한 날짜·숫자·담당자·해야 할 일은 빠뜨리지 마세요.' },
    { id: 'report', icon: 'file-text', name: '보고서·공문 초안', input: '쓸 내용(메모·개요)', needsText: true, extra: '문서 종류 (예: 업무 보고, 협조 요청 공문, 계획서)', ask: '아래 메모를 바탕으로 {extra} 초안을 써 주세요. 제목, 목적, 주요 내용, 향후 계획 순서로 정리하고, 메모에 없는 사실은 지어내지 말고 [확인 필요]라고 표시하세요.', extraDefault: '업무 보고서' },
    { id: 'polish', icon: 'pen-line', name: '문장 다듬기·맞춤법', input: '다듬을 글', needsText: true, ask: '아래 글의 맞춤법과 띄어쓰기를 바로잡고 문장을 자연스럽게 다듬어 주세요. 뜻은 바꾸지 말고, 고친 글 다음에 무엇을 왜 고쳤는지 짧게 알려 주세요.' },
    { id: 'plain', icon: 'lightbulb', name: '쉬운 말로', input: '어려운 글', needsText: true, ask: '아래 글을 처음 보는 사람도 이해할 수 있게 쉬운 말로 풀어 써 주세요. 전문 용어는 한 번씩 뜻을 설명해 주세요.' },
    { id: 'translate', icon: 'languages', name: '번역', input: '번역할 글', needsText: true, extra: '어느 말로 (예: 영어, 한국어, 일본어)', ask: '아래 글을 {extra}로 번역해 주세요. 공문서에 맞는 자연스러운 표현을 쓰고, 고유명사와 숫자는 그대로 두세요.', extraDefault: '영어' },
    { id: 'minutes', icon: 'clipboard-list', name: '회의록 정리', input: '회의 메모', needsText: true, ask: '아래 회의 메모를 회의록으로 정리해 주세요. 안건별 논의 내용, 결정 사항, 후속 조치(담당자·기한)를 나누어 쓰고, 메모에 없는 내용은 넣지 마세요.' },
    { id: 'reply', icon: 'mail', name: '답장·안내문 초안', input: '받은 글 또는 상황', needsText: true, extra: '답장에 담을 내용 (예: 다음 주까지 회신하겠다)', ask: '아래 글에 대한 답장 초안을 써 주세요. 꼭 담을 내용: {extra}. 정중하고 분명하게, 인사말과 맺음말을 넣어 주세요.', extraDefault: '검토 후 회신하겠다' },
    { id: 'excel', icon: 'table', name: '엑셀 수식·함수', input: '하고 싶은 계산 (표 모양과 함께)', needsText: true, ask: '엑셀(한셀)에서 아래와 같은 계산을 하려고 합니다. 쓸 수식을 알려 주고, 수식의 각 부분이 무슨 뜻인지와 주의할 점을 설명해 주세요.' },
    { id: 'ideas', icon: 'target', name: '아이디어·개선안', input: '주제나 문제 상황', needsText: true, ask: '아래 주제에 대해 실행할 수 있는 아이디어를 7가지 제안해 주세요. 각각 기대 효과와 필요한 준비를 한 줄씩 붙이고, 먼저 해 볼 만한 것 3가지를 골라 주세요.' },
    { id: 'free', icon: 'message-circle', name: '자유 질문', input: '물어볼 내용', needsText: true, ask: '' }
  ]

  const TONES = { formal: '격식 있는 공문서체(~합니다, ~하시기 바랍니다)', plain: '간결한 개조식(~함, ~임)', friendly: '친근하고 부드러운 말투' }
  const LENGTHS = { short: '짧게(3~5줄)', medium: '보통(한 화면 안)', long: '자세하게' }
  const FORMATS = { any: '', bullets: '글머리표 목록으로', table: '표로', steps: '번호를 붙인 단계로' }

  const str = (v, max) => String(v == null ? '' : v).replace(/\r\n/g, '\n').trim().slice(0, max)
  const taskOf = (id, custom) => TASKS.concat(custom || []).find((t) => t.id === id) || TASKS[TASKS.length - 1]

  /**
   * The question to paste into Copilot. Returns { prompt } or { error }.
   * o: { task, text, extra, tone, length, format, custom }
   */
  function build(o) {
    const task = taskOf(o.task, o.custom)
    const text = str(o.text, 20000)
    if (task.needsText !== false && !text) return { error: `${task.input || '내용'}을(를) 적어 주세요.` }
    const extra = str(o.extra, 200) || task.extraDefault || ''
    const ask = String(task.ask || '').replace(/\{extra\}/g, extra)
    const wants = []
    if (TONES[o.tone]) wants.push(`말투: ${TONES[o.tone]}`)
    if (LENGTHS[o.length] && o.length !== 'medium') wants.push(`분량: ${LENGTHS[o.length]}`)
    if (FORMATS[o.format]) wants.push(`형식: ${FORMATS[o.format]}`)
    wants.push('한국어로 답해 주세요.')
    const list = wants.map((w) => `- ${w}`).join('\n')
    if (!ask) return { prompt: [text, '', list].join('\n') }
    // the material goes last between marks, so instructions and material cannot be mixed up
    return { prompt: [ask, '', list, '', '--- 아래부터 내용 ---', text, '--- 내용 끝 ---'].join('\n') }
  }

  /** A task the user made: a name and an instruction. */
  function customTask(name, ask) {
    const n = str(name, 30)
    const a = str(ask, 500)
    if (!n || !a) return null
    return { id: 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36), icon: 'star', name: n, input: '내용', needsText: true, ask: a, custom: true }
  }

  const titleOf = (prompt) => {
    const first = String(prompt || '').split('\n').map((l) => l.trim()).find(Boolean) || ''
    return first.length > 50 ? first.slice(0, 50) + '…' : first
  }

  g.CopilotPrompts = { TASKS, TONES, LENGTHS, FORMATS, build, customTask, taskOf, titleOf }
})(typeof window !== 'undefined' ? window : globalThis)
