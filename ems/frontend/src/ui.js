/* UI barrel — aggregates the shared component set that pages consume as a
   single namespace (`import * as ui from '../ui.js'`), replacing the old
   window.App.ui object that components.js, charts.js and table.js populated. */
export {
  PageHeader, Card, Badge, Button, Select, TextField, Tooltip, ToastHost,
} from './components.js';
export { LineChart, BarChart } from './charts.js';
export { DataTable } from './table.js';
