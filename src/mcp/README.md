# MCP: tools существующему клиенту

MCP server публикует инструменты для уже подключённого клиента поверх runtime. Он проверяет grants для roots/operations, валидирует inputs, ограничивает размер ответа и сериализует результат или safe error.

```mermaid
flowchart TD
 A["Существующий MCP client request"] --> B["createSearchMcpServer + SearchMcpAccess"]
 B --> C{"Grant разрешает root и operation?"}
 C -->|"нет"| D["Отказ до runtime"]
 C -->|"да"| E["Strict tool input schema"]
 E --> F{"Вход валиден?"}
 F -->|"нет"| G["Validation error"]
 F -->|"да"| H["Передать signal и вызвать runtime capability"]
 H --> I{"Результат или отказ?"}
 I -->|"result"| J["boundedSuccess: лимит ответа"]
 I -->|"known runtime error"| K["Safe typed error code"]
 I -->|"unknown error"| L["Sanitized error"]
 J --> M["MCP response → caller"]
 K --> M
 L --> M
 N["Client cancellation"] --> O["Передать cancellation owned operation"]
 P["Runtime shutdown"] --> Q["Cancel/drain; transport не закрывает borrowed DB"]
```

| Условие | Результат | Кодовая опора |
| --- | --- | --- |
| Grant не разрешает root/operation | Tool не вызывает runtime. | `createSearchMcpServer` |
| Invalid input | Strict schema error. | `SEARCH_MCP_TOOL_CONTRACTS`, runtime request schemas |
| Oversized response | Успешная выдача полного якобы bounded ответа запрещена. | `boundedSuccess` |
| Известный runtime error | Возвращается стабильный safe code. | `safeCode` |
| Capability disabled | Conditional tool не регистрируется, например project-text/visual. | tool registration |

MCP — transport adapter, не agent/decision engine. Контракты: [`server.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/mcp/server.ts). Remote daemon/OAuth — другой слой.
