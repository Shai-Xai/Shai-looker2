// Shared modular ECharts build. Importing the full `echarts` package pulls the
// entire library (~975KB min / 329KB gz) into the eagerly-loaded chart chunk —
// every chart type, coordinate system and renderer, most of which we never use.
// Here we register ONLY what our charts actually need, which typically cuts the
// echarts payload 50-65%. Every component the option objects reference across
// ChartTile / EventOpsConsole / SettlementViewPage must be registered here — a
// missing one silently drops that feature at runtime, so keep this generous and
// add to it when a new option key is used.
//
// Import the configured `echarts` from here (never from 'echarts') and render
// with `echarts-for-react/lib/core` passing this instance.

import * as echarts from 'echarts/core';
import { BarChart, LineChart, PieChart, ScatterChart } from 'echarts/charts';
import {
  TooltipComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  AxisPointerComponent,
  DatasetComponent,
  MarkLineComponent,
} from 'echarts/components';
import { LabelLayout } from 'echarts/features';
import { CanvasRenderer } from 'echarts/renderers';
import { SVGRenderer } from 'echarts/renderers';

echarts.use([
  BarChart, LineChart, PieChart, ScatterChart,
  TooltipComponent, GridComponent, LegendComponent, TitleComponent,
  AxisPointerComponent, DatasetComponent, MarkLineComponent,
  LabelLayout,
  CanvasRenderer, SVGRenderer, // EventOpsConsole renders SVG; the rest default to canvas
]);

export default echarts;
export { echarts };
