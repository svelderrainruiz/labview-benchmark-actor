export function normalizeCoberturaXml(xml) {
  return String(xml)
    .replace(/\r\n?/g, '\n')
    .replace(/ timestamp="[^"]*"/, ' timestamp="0"')
    .replace(/<sources>[\s\S]*?<\/sources>/, '<sources>\n    <source>.</source>\n  </sources>');
}

export function coberturaWorkingTreeText(xml, checkedOutText = '') {
  const normalized = normalizeCoberturaXml(xml);
  return String(checkedOutText).includes('\r\n') ? normalized.replace(/\n/g, '\r\n') : normalized;
}
