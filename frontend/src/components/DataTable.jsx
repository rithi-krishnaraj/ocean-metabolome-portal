import {
  useReactTable,
  getCoreRowModel,
  getPaginationRowModel,
  flexRender,
} from '@tanstack/react-table'
import { useMemo } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

export default function DataTable({ data = [], pageSize = 10 }) {
  const columns = useMemo(() => {
    if (!data?.length) return []
    return Object.keys(data[0]).map((key) => ({
      id: key,
      accessorKey: key,
      header: key,
      cell: (info) => {
        const v = info.getValue()
        if (v === null || v === undefined) return <span className="text-slate-500">—</span>
        return <span title={String(v)}>{String(v)}</span>
      },
    }))
  }, [data])

  const table = useReactTable({
    data: data ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize } },
  })

  if (!data?.length)
    return <p className="text-slate-500 text-sm py-4 text-center">No data to display.</p>

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-700">
      <table className="w-full text-xs border-collapse">
        <thead className="bg-slate-700 sticky top-0">
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => (
                <th
                  key={h.id}
                  className="px-3 py-2 text-left font-medium text-slate-300 whitespace-nowrap border-b border-slate-600"
                >
                  {flexRender(h.column.columnDef.header, h.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row, i) => (
            <tr
              key={row.id}
              className={i % 2 === 0 ? 'bg-slate-800' : 'bg-slate-800/60'}
            >
              {row.getVisibleCells().map((cell) => (
                <td
                  key={cell.id}
                  className="px-3 py-1.5 text-slate-300 border-b border-slate-700/50 max-w-48 overflow-hidden text-ellipsis whitespace-nowrap"
                >
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {/* Pagination */}
      <div className="flex items-center justify-between px-3 py-2 bg-slate-800 border-t border-slate-700">
        <span className="text-slate-400 text-xs">
          Page {table.getState().pagination.pageIndex + 1} / {Math.max(1, table.getPageCount())}
          {' · '}
          {data.length} rows
        </span>
        <div className="flex gap-1">
          <button
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            className="p-1 rounded hover:bg-slate-700 disabled:opacity-30 text-slate-400"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            className="p-1 rounded hover:bg-slate-700 disabled:opacity-30 text-slate-400"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>
    </div>
  )
}
