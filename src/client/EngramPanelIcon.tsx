/**
 * 顶层侧栏「记忆宫殿」入口图标。
 *
 * 复刻国会式宫殿线稿（用户指定参考图）：顶针、顶亭、双层穹顶、中央拱门、
 * 鼓座环带、鼓座柱、大檐口、山墙与内三角、主柱廊、柱间饰块、侧翼双排窗、
 * 栏杆与台阶，全元素保留。单色 currentColor，深浅主题与选中态交给宿主。
 * 描边不随 555 设计稿等比缩放（等比在 16px 下细于 0.5px 会消失），按渲染
 * 尺寸补偿：28 ≈ 0.8px@16 / 0.9px@18，密集细节由抗锯齿呈现为雕版质感。
 * @module @kenz1117/dsh-engram/client/EngramPanelIcon
 */

import type { ReactElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** 555 设计稿的线稿路径，与 icon.svg / icon-256.svg 逐元素一致。 */
const PATHS: string[] = [
  'M277 2v30',
  'M250 30h55v40h-55z',
  'M200 106a77 36 0 0 1 154 0',
  'M232 106a45 21 0 0 1 90 0',
  'M262 106v-10a15 11 0 0 1 30 0v10',
  'M180 106h194M180 128h194M180 94v34M374 94v34',
  'M215 128v56M339 128v56',
  'M119 184h317M119 211h317M119 172v39M436 172v39',
  'M119 262L277 170l159 92',
  'M119 262h317',
  'M163 262L277 214l115 48',
  'M150 290h255',
  'M150 262v243M405 262v243',
  'M200 340h8v8h-8z',
  'M244 340h8v8h-8z',
  'M287 340h8v8h-8z',
  'M331 340h8v8h-8z',
  'M190 300v118M233.5 300v118M277 300v118M321 300v118M364 300v118',
  'M150 440h255',
  'M203 452v48M240 452v48M277 452v48M314 452v48M351 452v48',
  'M20 280v225M535 280v225',
  'M20 280h130M20 305h130M20 347h130',
  'M405 280h130M405 305h130M405 347h130',
  'M20 425h130M405 425h130',
  'M42 366h28v28h-28z',
  'M100 366h28v28h-28z',
  'M427 366h28v28h-28z',
  'M485 366h28v28h-28z',
  'M42 452h28v28h-28z',
  'M100 452h28v28h-28z',
  'M427 452h28v28h-28z',
  'M485 452h28v28h-28z',
  'M20 505h515M48 528h459',
]

export function EngramPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 -10 555 555" aria-hidden="true" focusable="false">
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth={28}
        strokeLinecap="butt"
        strokeLinejoin="miter"
      >
        {PATHS.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  )
}

