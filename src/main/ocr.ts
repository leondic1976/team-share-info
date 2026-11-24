import { app } from 'electron'
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log/main'
import { assembleOcr, type OcrRaw, type OcrResult } from '../shared/ocr'

/**
 * Text recognition with the recognizer built into Windows (Windows.Media.Ocr): it works
 * without internet, needs nothing installed, and the picture never leaves this PC.
 * The script is fixed; the picture's path and the language reach it through the environment.
 */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
  function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
  $langs = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
  $engine = $null
  if ($env:TEAMHUB_OCR_LANG) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language $env:TEAMHUB_OCR_LANG)) }
  if (-not $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if (-not $engine) { @{ ok = $false; error = 'no-engine'; languages = $langs } | ConvertTo-Json -Compress; exit 0 }
  if (-not $env:TEAMHUB_OCR_PATH) { @{ ok = $true; language = $engine.RecognizerLanguage.LanguageTag; languages = $langs; lines = @() } | ConvertTo-Json -Compress; exit 0 }
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:TEAMHUB_OCR_PATH)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $r = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $stream.Dispose()
  $lines = @($r.Lines | ForEach-Object { , @($_.Words | ForEach-Object { @{ t = $_.Text; x = [math]::Round($_.BoundingRect.X); y = [math]::Round($_.BoundingRect.Y); w = [math]::Round($_.BoundingRect.Width); h = [math]::Round($_.BoundingRect.Height) } }) })
  @{ ok = $true; language = $engine.RecognizerLanguage.LanguageTag; languages = $langs; lines = $lines } | ConvertTo-Json -Compress -Depth 6
} catch {
  @{ ok = $false; error = [string]$_.Exception.Message } | ConvertTo-Json -Compress
}
`

/** Pictures come from a canvas of the screen that asks: PNG or JPEG, up to 12MB. */
const DATA_URL = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/
const MAX_BYTES = 12 * 1024 * 1024
const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/

const NO_ENGINE = '이 PC의 Windows에 글자 인식(OCR) 언어가 설치되어 있지 않습니다. Windows 설정 → 시간 및 언어 → 언어 및 지역 → 한국어 → 언어 옵션에서 "광학 문자 인식"을 설치하세요.'

function run(env: Record<string, string>): Promise<OcrRaw | null> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', SCRIPT],
      { windowsHide: true, timeout: 60000, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ...env } },
      (_err, stdout) => {
        try {
          resolve(JSON.parse((stdout ?? '').trim()) as OcrRaw)
        } catch {
          resolve(null)
        }
      }
    )
  })
}

const list = (v: string[] | string | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v])

/** Read the text of a picture. `dataUrl` empty: only tell which languages this PC can read. */
export async function recognizeImage(dataUrl: string, lang?: string): Promise<OcrResult> {
  if (process.platform !== 'win32') return { ok: false, error: 'Windows에서만 쓸 수 있습니다.' }
  const env: Record<string, string> = { TEAMHUB_OCR_PATH: '', TEAMHUB_OCR_LANG: lang && LANG.test(lang) ? lang : '' }
  let file = ''
  try {
    if (dataUrl) {
      const m = DATA_URL.exec(dataUrl)
      if (!m) return { ok: false, error: '읽을 수 없는 이미지 형식입니다(PNG·JPG).' }
      const buf = Buffer.from(m[2], 'base64')
      if (!buf.length || buf.length > MAX_BYTES) return { ok: false, error: '이미지가 너무 큽니다(12MB까지).' }
      file = join(app.getPath('temp'), `teamhub-ocr-${randomBytes(8).toString('hex')}.${m[1] === 'png' ? 'png' : 'jpg'}`)
      writeFileSync(file, buf)
      env.TEAMHUB_OCR_PATH = file
    }
    const raw = await run(env)
    if (!raw) return { ok: false, error: '글자 인식을 실행하지 못했습니다. 잠시 뒤 다시 해 보세요.' }
    const languages = list(raw.languages)
    if (!raw.ok) {
      if (raw.error !== 'no-engine') log.warn('[ocr] failed', raw.error)
      return { ok: false, languages, error: raw.error === 'no-engine' ? NO_ENGINE : `글자를 읽지 못했습니다. ${raw.error ?? ''}`.trim() }
    }
    return { ok: true, language: raw.language, languages, ...assembleOcr(raw.lines) }
  } finally {
    // the picture is not kept
    if (file) rmSync(file, { force: true })
  }
}
