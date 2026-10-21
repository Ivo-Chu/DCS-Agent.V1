$ErrorActionPreference = 'Stop'
$webRoot = if ($env:DCS_WEBAPP_ROOT) { $env:DCS_WEBAPP_ROOT } else { 'D:\work\DCS code\Luxshare.DCS.WebApp' }
$source = Get-Content -Raw -LiteralPath (Join-Path $webRoot 'Controllers\HomeController.cs')
$method = [regex]::Match($source, '(?s)public ActionResult GetDcsAgentSSOCode\(\).*?(?=\s*public JsonResult GetSSOCode)').Value
if (!$method) { throw 'Agent SSO method not found' }
# 编译实际 MVC action 的方法体，替换 MVC/加密依赖为可观测桩；不是复制签发判断。
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
public class ActionResult { public string Value; public int Status = 200; }
public class HttpStatusCodeResult : ActionResult { public HttpStatusCodeResult(int status, string message) { Status = status; Value = message; } }
public class UserInfo { public string EmpCode; }
public static class CommonConstValue { public const string CurrentUser = "_CurrentUser"; }
public enum LoginTypeEnum { DCSSSO }
public static class DCSHelper { public static string GetOneLogin(string employee, LoginTypeEnum type) { return employee; } }
public class SsoProbe {
  public Dictionary<string,object> Session = new Dictionary<string,object> { { "_CurrentUser", null } };
  public UserInfo User;
  public void Configure(string sessionEmployee, string headerEmployee) {
    Session["_CurrentUser"] = sessionEmployee == null ? null : new UserInfo { EmpCode = sessionEmployee };
    User = new UserInfo { EmpCode = headerEmployee };
  }
  public ActionResult Json(string value) { return new ActionResult { Value = value }; }
  $method
}
"@
foreach ($header in @('A','B',$null)) {
    $probe = New-Object SsoProbe
    $probe.Configure('A', $header)
    $result = $probe.GetDcsAgentSSOCode()
    if ($result.Status -ne 200 -or $result.Value -ne 'A') { throw "A Session + $header header did not sign A" }
}
$probe = New-Object SsoProbe
$probe.Configure($null, 'B')
if ($probe.GetDcsAgentSSOCode().Status -ne 401) { throw 'Header identity accepted without Session' }
$probe.Configure(' ', 'B')
if ($probe.GetDcsAgentSSOCode().Status -ne 401) { throw 'Empty Session employee accepted' }
$probe.Session = $null
if ($probe.GetDcsAgentSSOCode().Status -ne 401) { throw 'Missing Session service accepted' }
Write-Output 'Actual C# Agent SSO action: 6 scenarios passed (MVC/crypto stubs, not IIS integration)'
