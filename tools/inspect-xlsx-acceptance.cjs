const fs = require('fs')
const crypto = require('crypto')
const ExcelJS = require('../app/node_modules/exceljs')

const file = process.argv[2]
if (!file) throw new Error('usage: node tools/inspect-xlsx-acceptance.cjs <xlsx>')

async function main() {
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.readFile(file)
  const sheets = workbook.worksheets.map((sheet) => {
    const rows = []
    sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      if (rowNumber <= 4) rows.push({ rowNumber, values: row.values.slice(1) })
    })
    return {
      name: sheet.name,
      rowCount: sheet.rowCount,
      columnCount: sheet.columnCount,
      sampleRows: rows
    }
  })
  const bytes = fs.statSync(file).size
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  const result = { file, bytes, sha256, sheets }
  const out = file.replace(/\.xlsx$/i, '.inspection.json')
  fs.writeFileSync(out, JSON.stringify(result, null, 2), 'utf8')
  process.stdout.write(JSON.stringify(result, null, 2))
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exitCode = 1
})
