import { Component, type ReactNode } from 'react'
import { useLocation } from 'react-router-dom'
import { TriangleAlert, RotateCcw } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'

interface State {
  error: Error | null
}

/**
 * One screen that fails (an error while drawing it or in one of its effects) must not take the
 * whole window down with it: the menu, the top bar and the other screens keep working, and the
 * failing screen says so with a way to try again (2026-11-25, 메모의 상용구 탭).
 */
class Boundary extends Component<{ children: ReactNode; resetKey: string }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    console.error('[page error]', error, info.componentStack)
  }

  componentDidUpdate(prev: { resetKey: string }): void {
    // going to another screen starts afresh
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center" role="alert" data-testid="page-error">
        <TriangleAlert className="size-10 text-important" aria-hidden />
        <h2 className="text-lg font-bold">이 화면을 여는 중에 오류가 났습니다</h2>
        <p className="max-w-md text-sm text-muted-foreground">다른 메뉴는 그대로 쓸 수 있습니다. 다시 시도해도 같으면 설정 → 기능요청 및 오류신고로 아래 내용을 알려 주세요.</p>
        <code className="selectable max-w-xl rounded-md bg-muted px-3 py-1.5 text-xs break-all">{error.message || String(error)}</code>
        <Button variant="outline" onClick={() => this.setState({ error: null })}>
          <RotateCcw /> 다시 시도
        </Button>
      </div>
    )
  }
}

export function PageErrorBoundary({ children }: { children: ReactNode }): React.JSX.Element {
  const { pathname } = useLocation()
  return <Boundary resetKey={pathname}>{children}</Boundary>
}
