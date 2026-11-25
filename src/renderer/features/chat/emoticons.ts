/**
 * 메신저 이모티콘: colour emoji grouped by situation. This file is the one place in the program
 * where emoji are allowed (user decision 2026-11-25, 지시 62; see `tests/shared/no-emoji.test.ts`).
 * Each entry is "emoji label": the label is shown on hover and used by the search box.
 */

export interface Emoticon {
  e: string
  label: string
}
export interface EmoticonGroup {
  id: string
  name: string
  items: Emoticon[]
}

const g = (id: string, name: string, list: string): EmoticonGroup => ({
  id,
  name,
  items: list
    .trim()
    .split('\n')
    .map((line) => {
      const [e, ...rest] = line.trim().split(' ')
      return { e, label: rest.join(' ') }
    })
})

export const EMOTICON_GROUPS: EmoticonGroup[] = [
  g('greet', '인사', `
👋 안녕하세요
🙇 꾸벅 인사
🤝 반갑습니다
☀️ 좋은 아침
🌙 좋은 밤 되세요
😴 퇴근합니다 피곤
🏃 먼저 가볼게요
🙋 저요 손들기
👀 확인했어요 봤어요
🫡 알겠습니다 경례
💤 졸려요
🏠 집에 갑니다`),
  g('joy', '기쁨·웃음', `
😀 웃음
😃 활짝 웃음
😄 기뻐요
😁 히히
😆 신나요
😂 너무 웃겨요
🤣 빵 터짐
😊 미소
🙂 살짝 미소
😉 윙크
😎 멋져요
🥳 파티
🤩 우와 반짝
😋 맛있어요
😌 흐뭇`),
  g('love', '사랑·감사', `
❤️ 하트 사랑
🧡 주황 하트
💛 노랑 하트
💚 초록 하트
💙 파랑 하트
💜 보라 하트
💕 두근두근
💖 반짝 하트
🥰 사랑스러워요
😍 반했어요
😘 쪽
🤗 안아줄게요
🙏 감사합니다 부탁해요
💐 꽃다발 감사
🌹 장미`),
  g('cheer', '응원·축하', `
👍 좋아요 최고
👏 박수
🙌 만세
💪 힘내세요 화이팅
🎉 축하해요
🎊 축하 폭죽
🎂 생일 축하
🎁 선물
🏆 우승 최고
🥇 1등 금메달
⭐ 별 잘했어요
✨ 반짝반짝
🔥 불타오르네 대박
💯 백점 완벽
🍀 행운을 빌어요
🌈 무지개 희망`),
  g('sad', '슬픔·위로', `
😢 눈물
😭 엉엉
🥲 웃프다
😞 실망
😔 시무룩
😟 걱정돼요
🥺 부탁해요 글썽
😿 슬퍼요
💔 상심
🫂 토닥토닥 위로
☔ 우울한 비
🍵 차 한잔 하며 쉬어요`),
  g('surprise', '놀람·당황', `
😮 오
😲 깜짝
😱 헉 무서워
🤯 머리 터질 듯
😳 당황
😅 땀 삐질
😬 어색
🙄 어이없음
🤔 음 생각중
🧐 자세히 보기
😶 할 말 없음
🫢 앗
❗ 느낌표 중요
❓ 물음표 질문
⁉️ 뭐라고요`),
  g('upset', '화남·곤란', `
😠 화났어요
😡 버럭
🤬 분노
😤 씩씩
😩 지쳤어요
😫 힘들어요
😵 어지러워요
🤒 아파요
🤧 감기 콜록
😷 마스크 조심
🥵 더워요
🥶 추워요
🙅 안 돼요
🤦 아이고`),
  g('ok', '대답·손짓', `
👌 오케이
✅ 완료 확인
☑️ 체크
❌ 안 됨 취소
⭕ 동그라미 맞아요
🙆 좋아요 동그라미
🤞 행운을 빌어요
✌️ 브이
👉 이쪽
👆 위를 보세요
👇 아래를 보세요
✋ 잠깐만요
🤙 전화 주세요
🫶 손하트`),
  g('work', '업무', `
💼 업무 가방
📄 문서
📁 폴더
📎 첨부
📌 고정 중요
📅 일정
⏰ 시간 알람
⏳ 기다리는 중
📞 전화
📧 메일
💻 컴퓨터 작업
🖨️ 인쇄
📊 보고 자료
📝 메모 작성
🔍 찾아보기
🚀 출발 진행
⚠️ 주의
🆗 확인
🔒 보안 비공개
🗂️ 서류 정리`),
  g('food', '식사·커피', `
☕ 커피 한잔
🍵 녹차
🧋 버블티
🍚 밥
🍜 라면 국수
🍲 찌개
🍱 도시락
🍙 주먹밥
🍕 피자
🍔 햄버거
🍗 치킨
🍰 케이크 간식
🍩 도넛
🍎 사과 과일
🍺 맥주 회식
🥤 음료`),
  g('weather', '날씨·계절', `
☀️ 맑음
⛅ 구름 조금
☁️ 흐림
🌧️ 비
⛈️ 천둥 번개
❄️ 눈 추위
⛄ 눈사람
🌸 봄 벚꽃
🌻 여름 해바라기
🍁 가을 단풍
🎄 크리스마스
🌊 바다 휴가`),
  g('animal', '동물', `
🐶 강아지
🐱 고양이
🐰 토끼
🐻 곰
🐼 판다
🐯 호랑이
🦁 사자
🐷 돼지
🐥 병아리
🐧 펭귄
🐢 거북이 느려요
🦄 유니콘`)
]

/** Every emoticon, in the order of the groups. */
export const ALL_EMOTICONS: Emoticon[] = EMOTICON_GROUPS.flatMap((x) => x.items)

/** Matches a message made only of emoji (and spaces), at most `max` of them: shown large. */
export function emojiOnly(text: string, max = 3): boolean {
  const s = text.trim()
  if (!s || s.length > 40) return false
  const parts = [...new Intl.Segmenter('ko', { granularity: 'grapheme' }).segment(s.replace(/\s+/g, ''))].map((x) => x.segment)
  return parts.length > 0 && parts.length <= max && parts.every((p) => /\p{Extended_Pictographic}/u.test(p))
}
