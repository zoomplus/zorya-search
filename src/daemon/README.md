# Daemon: HTTP transport и lifecycle

Daemon принимает HTTP transport, проверяет transport access policy и направляет разрешённые MCP operations к runtime. При disconnect/close он отменяет принадлежащие requests и дожидается их завершения.

```mermaid
flowchart TD
 A["HTTP/MCP transport request"] --> B["Проверить bind, path, headers, body limits"]
 B --> C{"Режим"}
 C -->|"OAuth remote"| D["Authorizer / principal / grants"]
 C -->|"IP allowlist candidate"| D2["CIDR / Host / Origin → principal / grants"]
 C -->|"local"| E["Local access policy"]
 D --> F{"Есть разрешённые roots и operations?"}
 D2 --> F
 E --> F
 F -->|"нет"| G["HTTP/auth/scope refusal"]
 F -->|"да"| H["Create MCP handler / route"]
 H --> I["Strict schema → runtime capability"]
 I --> J["Bounded response или safe error"]
 J --> K["HTTP response/session owner"]
 L["Disconnect/timeout"] --> M["Abort request"]
 M --> N["Await operation и закрыть принадлежащую session"]
 O["Daemon close"] --> P["Stop admission; abort requests, sessions, sockets"]
 P --> Q["Drain active HTTP/auth jobs"]
 Q --> R["Runtime drains owned work → owner closes DB"]
```

| Условие | Результат | Кодовая опора |
| --- | --- | --- |
| Неверные bind/path/header/body | Отказ до dispatch. | `startSearchDaemon` |
| Нет remote principal/grant | Отказ с root/operation scope. | `SearchDaemonAuthorizer`, `snapshotAccess` |
| IP mode: peer/CIDR, Host или Origin не прошли policy; присутствует Authorization | Отказ до dispatch; forwarded `X-Real-IP` учитывается только для доверенного proxy. | `createSearchIpAccessPolicy`, `startSearchDaemon` |
| Client disconnect | Abort конкретного request; дождаться settlement перед освобождением session. | `requestControllers`, `closeSession` |
| Daemon close | Stop admission, drain jobs/connections. | `close` |
| Внешний TLS/issuer | Настраивает deployment owner; код не доказывает deployment acceptance. | transport contract |
| Candidate `v0.1.11` IP mode | Явная policy без bearer/OAuth; metadata `noauth` только в этом режиме, grants остаются серверными. | `serve-remote-ip`, `ip-access.ts` |

Daemon не управляет client agent. Источник: [`index.ts`](https://github.com/zoomplus/zorya-search/blob/main/src/daemon/index.ts).
