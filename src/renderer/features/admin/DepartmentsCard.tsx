import { useNavigate } from 'react-router-dom'
import { Network } from 'lucide-react'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { useMe } from '@renderer/lib/queries'

/**
 * Departments used to be managed here. They now live in one place, 설정 → 조직 관리, which
 * only the server PC (최종관리자) has; this card only points there.
 */
export function DepartmentsCard(): React.JSX.Element {
  const navigate = useNavigate()
  const { data: me } = useMe()
  return (
    <Card data-testid="departments-moved">
      <CardHeader>
        <CardTitle>부서 (조직도)</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3 text-sm">
        <p className="min-w-0 flex-1 text-muted-foreground">
          부서 추가·삭제, 부서장, 구성원 배치(부서·직위·직급·순서)는 <b className="text-foreground">설정 → 조직 관리</b>에서 합니다. 최종관리자(서버 PC)만 할 수 있습니다.
        </p>
        <Button size="sm" variant="outline" onClick={() => navigate('/org')}>
          <Network /> 조직도 보기
        </Button>
        {me?.isOwner === true && (
          <Button size="sm" onClick={() => navigate('/settings', { state: { focus: 'org' } })}>
            조직 관리 열기
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
