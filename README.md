# GitHub Actions tModLoader 24/7 서버

## 구조
- `server.yml` : 서버 실행(약 5시간 49분). 종료 5분 전부터 1분마다 인게임 영어 공지 → save → 백업 → 새 실행 dispatch
- `watchdog.yml` : 20분마다 확인, 실행 중인 서버가 없으면 자동 기동
- `world-request.yml` + 이슈 템플릿 : 이슈로 월드 생성/전환/설정 변경. 기여자(OWNER/MEMBER/COLLABORATOR/CONTRIBUTOR)만 승인
- `server/supervisor.js` : 서버 감독(마지막 월드 이어서 열기, 크래시 재시작, 이슈 처리, 10분마다 자동 저장/백업)
- 월드 백업 : `data` 브랜치에 단일 커밋을 force push(덮어쓰기). `config.json`(활성 월드·설정)도 같이 저장

## 설정 순서
1. 레포를 **public**으로 만들기 (private은 무료 분 한도로 24시간 불가)
2. Settings → Actions → General → Workflow permissions: **Read and write**
3. https://playit.gg 에서 에이전트 생성 → 시크릿 키를 레포 시크릿 `PLAYIT_SECRET`에 등록, 대시보드에서 **TCP 터널 → 로컬 127.0.0.1:7777** 생성 (이 주소가 접속 주소, 재시작해도 고정)
4. (선택) 시크릿 `SERVER_PASSWORD`, 변수 `TML_VERSION`(예: 클라이언트와 맞출 tModLoader 태그)
5. `server/mods.json`의 `workshopIds`에 안티그리프/안티치트 모드와 의존 모드의 Workshop ID 입력
6. Actions 탭에서 **Terraria Server** 를 한 번 수동 실행 (이후엔 자동 연장 + watchdog)

## 이슈 사용
New issue → World request 선택 → Action 고르고 제출. 서버가 최대 30초 안에 감지해서 처리:
저장·백업 → 인게임 30초 공지 → 월드 전환/생성 후 재시작 → 새 월드 백업 → 이슈에 결과 코멘트 후 닫음.
실패하면 이전 월드/설정으로 롤백.

## 주의
- 접속자는 재시작 때마다 약 2~3분간 끊깁니다.
- 클라이언트의 tModLoader 버전·모드 목록이 서버와 같아야 접속됩니다.
- 24시간 게임 서버 용도는 GitHub 이용약관상 문제가 될 수 있으니 본인 책임으로 사용하세요.
- 레포에 60일간 활동이 없으면 예약(schedule) 워크플로가 중지될 수 있습니다.
