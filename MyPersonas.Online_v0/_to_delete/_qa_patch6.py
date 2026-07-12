#!/usr/bin/env python3
import base64,sys,os
D=os.path.dirname(os.path.abspath(__file__)); IDX=os.path.join(D,'index.html')
TAGJS=base64.b64decode("Ci8vIC0tLS0tIGhhc2h0YWcgYnJvd3NlIHBhZ2VzIC0tLS0tCmFzeW5jIGZ1bmN0aW9uIHJlbmRlclRhZyh0YWcpewogIHNldE1ldGEoIiMiK3RhZysiIOKAlCBNeVBlcnNvbmFzIiwiUG9zdHMgYWNyb3NzIHRoZSBuZXR3b3JrIHRhZ2dlZCAjIit0YWcpOwogIGFwcC5pbm5lckhUTUw9JzxkaXYgY2xhc3M9ImVtcHR5Ij5Mb2FkaW5n4oCmPC9kaXY+JzsKICBjb25zdCB7ZGF0YX09YXdhaXQgc2IuZnJvbSgicG9zdHMiKS5zZWxlY3QoIiosIHBlcnNvbmFzIWlubmVyKGlkLG5hbWUsaGFuZGxlLGF2YXRhcl91cmwsbnNmdyx0aGVtZSx2aXNpYmlsaXR5KSIpCiAgICAuZXEoInBlcnNvbmFzLnZpc2liaWxpdHkiLCJwdWJsaWMiKS5pbGlrZSgidGFncyIsIiUiK3RhZysiJSIpLm9yZGVyKCJjcmVhdGVkX2F0Iix7YXNjZW5kaW5nOmZhbHNlfSkubGltaXQoNjApOwogIGNvbnN0IGY9Z2V0RmlsdGVycygpOwogIGNvbnN0IHBvc3RzPShkYXRhfHxbXSkuZmlsdGVyKHI9PiEoZi5oaWRlTnNmdyYmci5wZXJzb25hcy5uc2Z3KSYmIWlzSGlkZGVuKHIucGVyc29uYXMuaWQpKTsKICBhcHAuaW5uZXJIVE1MPWA8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDoxMHB4O2ZsZXgtd3JhcDp3cmFwO21hcmdpbi1ib3R0b206MTJweCI+CiAgICA8aDMgY2xhc3M9InNlY3RoZWFkIiBzdHlsZT0ibWFyZ2luOjAiPiMke2VzYyh0YWcpfTwvaDM+CiAgICA8YnV0dG9uIGNsYXNzPSJidG4gc2VjIHNtIiBvbmNsaWNrPSJnbygnJykiPkJhY2sgdG8gZGlzY292ZXI8L2J1dHRvbj48L2Rpdj4KICAgICR7cG9zdHMubWFwKHg9PnBvc3RIdG1sKHgseC5wZXJzb25hcyxmYWxzZSkpLmpvaW4oIiIpfHxgPGRpdiBjbGFzcz0iZW1wdHkiPk5vIHB1YmxpYyBwb3N0cyB0YWdnZWQgIyR7ZXNjKHRhZyl9IHlldC48L2Rpdj5gfWA7Cn0K").decode()
ROUTE_OLD=base64.b64decode("aWYodmlldz09PSJzZWFyY2giKXJldHVybiByZW5kZXJEaXNjb3ZlcihhcmcsbXlFcG9jaCk7").decode()
ROUTE_NEW=base64.b64decode("aWYodmlldz09PSJ0YWciKXJldHVybiByZW5kZXJUYWcoYXJnKTsKICBpZih2aWV3PT09InNlYXJjaCIpcmV0dXJuIHJlbmRlckRpc2NvdmVyKGFyZyxteUVwb2NoKTs=").decode()
OLD_TAG=base64.b64decode("b25jbGljaz0icGFnZVNlYXJjaCgnJHtlc2ModC50cmltKCkpfScpIj4j").decode()
NEW_TAG=base64.b64decode("b25jbGljaz0iZ28oJ3RhZy8nK2VuY29kZVVSSUNvbXBvbmVudCgnJHtlc2ModC50cmltKCkpfScpKSI+Iw==").decode()
h=open(IDX,encoding='utf-8').read()
if 'renderTag' in h: print('ABORT: already applied'); sys.exit(2)
# 1) route case
if h.find(ROUTE_OLD)!=h.rfind(ROUTE_OLD) or h.find(ROUTE_OLD)<0: raise SystemExit('route anchor bad')
h=h.replace(ROUTE_OLD,ROUTE_NEW,1)
# 2) post tag chips -> global hashtag page
if h.find(OLD_TAG)<0: raise SystemExit('post tag anchor missing')
h=h.replace(OLD_TAG,NEW_TAG,1)
# 3) append renderTag
sc=h.rfind('</script>'); h=h[:sc]+TAGJS+'\n'+h[sc:]
open(IDX,'w',encoding='utf-8',newline='\r\n').write(h)
print('OK hashtag pages; renderTag=',h.count('renderTag'),"tagRoute=",h.count('view==="tag"'),'globalTagChip=',h.count("go('tag/'+encodeURIComponent"))
