import { useEffect, useState, type ReactNode } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
  type SortingState,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';


declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData, TValue> {
    className?: string;
  }
}

export interface DataTableProps<T> {
  columns: ColumnDef<T, any>[];
  data: T[];
  getRowId: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Accessible label for a row, used by the row-select checkbox. */
  rowLabel?: (row: T) => string;
  selectable?: boolean;
  selection?: RowSelectionState;
  onSelectionChange?: (s: RowSelectionState) => void;
  initialSorting?: SortingState;
  pageSize?: number;
  empty?: ReactNode;
  /** Reset to page 1 when this changes (e.g. search text). */
  resetKey?: unknown;
  rowClassName?: (row: T) => string | undefined;
}

export function DataTable<T>({ columns, data, getRowId, onRowClick, rowLabel, selectable, selection, onSelectionChange, initialSorting = [], pageSize = 25, empty, resetKey, rowClassName }: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize });

  useEffect(() => setPagination((p) => ({ ...p, pageIndex: 0 })), [resetKey]);

  const selectColumn: ColumnDef<T, unknown> = {
    id: '__select',
    enableSorting: false,
    meta: { className: 'w-10' },
    header: ({ table }) => (
      <Checkbox
        aria-label="Select all rows on this page"
        checked={table.getIsAllPageRowsSelected() ? true : table.getIsSomePageRowsSelected() ? 'indeterminate' : false}
        onCheckedChange={(v) => table.toggleAllPageRowsSelected(Boolean(v))}
      />
    ),
    cell: ({ row }) => (
      <Checkbox
        aria-label={`Select ${rowLabel ? rowLabel(row.original) : 'row'}`}
        checked={row.getIsSelected()}
        disabled={!row.getCanSelect()}
        onClick={(e) => e.stopPropagation()}
        onCheckedChange={(v) => row.toggleSelected(Boolean(v))}
      />
    ),
  };

  const table = useReactTable({
    data,
    columns: selectable ? [selectColumn, ...columns] : columns,
    getRowId,
    state: { sorting, pagination, rowSelection: selection ?? {} },
    enableRowSelection: selectable,
    onRowSelectionChange: (updater) => {
      if (!onSelectionChange) return;
      onSelectionChange(typeof updater === 'function' ? updater(selection ?? {}) : updater);
    },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    autoResetPageIndex: false,
  });

  const rows = table.getRowModel().rows;
  const total = data.length;
  const from = total === 0 ? 0 : pagination.pageIndex * pagination.pageSize + 1;
  const to = Math.min(total, (pagination.pageIndex + 1) * pagination.pageSize);

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader className="bg-muted/50">
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id} className="hover:bg-transparent">
                {hg.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const dir = header.column.getIsSorted();
                  return (
                    <TableHead key={header.id} className={cn('h-10 text-xs font-medium uppercase tracking-wide text-muted-foreground', header.column.columnDef.meta?.className)} aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : undefined}>
                      {header.isPlaceholder ? null : canSort ? (
                        <button type="button" className="-ml-2 inline-flex items-center gap-1 rounded px-2 py-1 uppercase hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" onClick={header.column.getToggleSortingHandler()}>
                          {flexRender(header.column.columnDef.header, header.getContext())}
                          {dir === 'asc' ? <ArrowUp className="size-3" /> : dir === 'desc' ? <ArrowDown className="size-3" /> : <ArrowUpDown className="size-3 opacity-40" />}
                        </button>
                      ) : (
                        flexRender(header.column.columnDef.header, header.getContext())
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={table.getVisibleLeafColumns().length} className="h-40 text-center text-sm text-muted-foreground">
                  {empty ?? 'No results.'}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow
                  key={row.id}
                  data-state={row.getIsSelected() ? 'selected' : undefined}
                  className={cn(onRowClick && 'cursor-pointer', rowClassName?.(row.original))}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (e.key === 'Enter' && e.target === e.currentTarget) onRowClick(row.original);
                        }
                      : undefined
                  }
                  tabIndex={onRowClick ? 0 : undefined}
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className={cn('py-2.5', cell.column.columnDef.meta?.className)}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {total > pagination.pageSize && (
        <div className="flex items-center justify-between gap-2 border-t px-4 py-2 text-sm text-muted-foreground">
          <span>
            {from}–{to} of {total}
          </span>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-sm" aria-label="Previous page" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>
              <ChevronLeft />
            </Button>
            <span className="px-2">
              Page {pagination.pageIndex + 1} of {table.getPageCount()}
            </span>
            <Button variant="ghost" size="icon-sm" aria-label="Next page" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>
              <ChevronRight />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
