package io.ikit.app;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // 注册自建热更新插件（下载 web 资源 zip → 解压 → hostFiles → reload）
        registerPlugin(WebUpdatePlugin.class);
    }
}
