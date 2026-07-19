import base64,sys
F="MyPersonas.Online_v0/index.html"
OB="ICAgIDxkaXYgaWQ9Im5ldEZlZWQiPiR7cmVjZW50Lm1hcChyPT5wb3N0SHRtbChyLHIucGVyc29uYXMsZmFsc2UpKS5qb2luKCIiKXx8JzxkaXYgY2xhc3M9ImVtcHR5Ij5ObyBwdWJsaWMgcG9zdHMgeWV0IOKAlCBjcmVhdGUgYSBwZXJzb25hIGFuZCBwb3N0IHNvbWV0aGluZy48L2Rpdj4nfTwvZGl2PgogICAgJHtuZXRGZWVkLmRvbmU/IiI6JzxkaXYgc3R5bGU9InRleHQtYWxpZ246Y2VudGVyO21hcmdpbi10b3A6MTZweCI+PGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIgaWQ9ImZlZWRNb3JlQnRuIiBvbmNsaWNrPSJsb2FkTW9yZU5ldEZlZWQoKSI+TG9hZCBtb3JlIHBvc3RzPC9idXR0b24+PC9kaXY+J31gOwo="
NB="ICAgIDxkaXYgaWQ9Im5ldEZlZWQiPiR7cmVjZW50Lm1hcChyPT5wb3N0SHRtbChyLHIucGVyc29uYXMsZmFsc2UpKS5qb2luKCIiKXx8JzxkaXYgY2xhc3M9ImVtcHR5Ij5ObyBwdWJsaWMgcG9zdHMgeWV0IOKAlCBjcmVhdGUgYSBwZXJzb25hIGFuZCBwb3N0IHNvbWV0aGluZy48L2Rpdj4nfTwvZGl2PgogICAgJHtuZXRGZWVkLmRvbmU/IiI6JzxkaXYgc3R5bGU9InRleHQtYWxpZ246Y2VudGVyO21hcmdpbi10b3A6MTZweCI+PGJ1dHRvbiBjbGFzcz0iYnRuIHNlYyIgaWQ9ImZlZWRNb3JlQnRuIiBvbmNsaWNrPSJsb2FkTW9yZU5ldEZlZWQoKSI+TG9hZCBtb3JlIHBvc3RzPC9idXR0b24+PC9kaXY+J31gOiIifWA7Cg=="
old=base64.b64decode(OB).decode("utf-8"); new=base64.b64decode(NB).decode("utf-8")
raw=open(F,"rb").read().decode("utf-8"); lf=raw.replace("\r\n","\n")
if new in lf: print("ALREADY"); sys.exit(0)
c=lf.count(old)
if c!=1: print("count",c); sys.exit(2)
lf=lf.replace(old,new,1)
open(F,"wb").write(lf.replace("\n","\r\n").encode("utf-8"))
print("FIXED")
